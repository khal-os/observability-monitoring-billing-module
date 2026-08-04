import {
  makeIngestFailureRepository,
  makeReprocessPendingUseCase,
  makeSyncBatchesUseCase,
  traceIngestionWorkerSettings,
} from '../factories/sync-factory.js';
import { makeDatabase } from '../factories/database-factory.js';
import { beatWorkerHeartbeat } from './worker-heartbeat.js';
import { assertIngestionIndexes } from '@observability/core/infrastructure/database/mongodb/helpers/assert-ingestion-indexes.js';

/**
 * T2 continuous form — the trace-ingestion-worker sidecar's entry point. An infinite
 * watermark loop, NOT a cron: a cycle drains the backlog in bounded
 * batches, then sleeps; by construction two cycles can never overlap.
 *
 * Shutdown contract: SIGTERM/SIGINT set a flag checked BETWEEN batches —
 * the in-flight batch always completes and advances the watermark before
 * exit. Graceful shutdown is a courtesy, not a correctness requirement:
 * a SIGKILL mid-batch just leaves the cursor un-advanced, and the re-read
 * batch is deduplicated by insertIfAbsent.
 *
 * Errors: the schema tripwire (startup) is FATAL — exit non-zero and let
 * the restart policy surface a visible crash loop instead of syncing an
 * unverified schema. Loop errors are treated as transient: logged, then
 * retried with doubling backoff (poison ROWS never even throw — the
 * source skips and records them, decision 62 + audit C-6.2; a poison
 * TRACE is dead-lettered by the use case, audit B-3).
 */
let stopping = false;
let wake: (() => void) | undefined;

const requestStop = (signal: string): void => {
  console.log(`Trace ingestion worker: ${signal} received — finishing current batch.`);
  stopping = true;
  wake?.();
};

process.on('SIGTERM', () => requestStop('SIGTERM'));
process.on('SIGINT', () => requestStop('SIGINT'));

/** Interruptible sleep — a stop signal cuts it short immediately. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);

    wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
  });

const TRANSIENT_BACKOFF_BASE_MS = 5_000;
const TRANSIENT_BACKOFF_CAP_MS = 300_000;

/**
 * The worker's body, extracted so every exit path — including the idle
 * stack's — leaves through the caller's `finally` (re-audit 2026-08, sync
 * minors: the idle branch used to `process.exit(0)`, skipping the
 * disconnect entirely).
 */
const runWorker = async (): Promise<void> => {
  const batchSync = makeSyncBatchesUseCase();

  if (!batchSync) {
    // Pre-onboarding stack: no ClickHouse source to page. EXIT non-zero
    // (audit G-1): the old idle branch kept the process alive, so the
    // pgrep-style healthcheck read "healthy" for a worker that would
    // never ingest — green-while-dead, while the source's ~49-day
    // retention burned. A visible crash loop is the honest signal
    // (decision 117's preference), and onboarding's `make up` recreates
    // the worker with the source enabled. Nothing depends_on or waits on
    // this service's health, so the loop blocks nobody.
    console.error(
      'Trace ingestion worker: continuous-sync source not configured — ' +
        'onboarding writes the project id that enables it (see ' +
        'clients/example.env). Exiting so the restart loop stays VISIBLE ' +
        'instead of idling green (audit G-1). Fixture-backed demos use ' +
        '`make sync` with TRACE_SOURCE=fixtures.',
    );
    process.exitCode = 1;

    return;
  }

  // Fatal by design: never sync through an unverified source schema —
  // and never write into a store whose idempotency index is missing
  // (audit G-2: without the unique traceId index, re-reads double-store
  // and the bill double-counts; `make migrate` is the only door).
  await assertIngestionIndexes();
  await batchSync.source.assertCompatibleSchema();

  // audit F-4: the resolved knobs in the first lines of the log — a
  // misconfigured knob must be visible without reading compose.
  console.log(
    `Trace ingestion worker: started (interval ${traceIngestionWorkerSettings.intervalMs / 1000}s, ` +
      `reprocess every ${traceIngestionWorkerSettings.reprocessIntervalMs / 1000}s).`,
  );

  const ingestFailureRepository = makeIngestFailureRepository();

  let backoffMs = TRANSIENT_BACKOFF_BASE_MS;
  let lastReprocessAt = 0;

  while (!stopping) {
    let drainFailed = false;

    try {
      // Drain the backlog: batch after batch until caught up. The stop
      // flag is honored between batches — never mid-batch.
      let caughtUp = false;

      while (!caughtUp && !stopping) {
        const report = await batchSync.useCase.syncNextBatch();

        // Progress, not process existence (audit G-1): only a COMPLETED
        // batch beats. Error paths deliberately fall through without
        // beating, so an outage or a wedge ages the heartbeat and the
        // container turns unhealthy instead of green-while-dead.
        beatWorkerHeartbeat();

        caughtUp = report.caughtUp;
      }

      backoffMs = TRANSIENT_BACKOFF_BASE_MS; // healthy cycle → reset
    } catch (error) {
      console.error(
        `Trace ingestion worker: cycle failed (retrying in ${backoffMs / 1000}s): ` +
          `${String(error)}`,
      );
      drainFailed = true;
    }

    // re-audit 2026-08 (sync item 3): the dead-letter trail gets a voice.
    // Parked traces are traces the archive is MISSING (invariant 6), and
    // until now the only sign of them was the log line of the cycle that
    // wrote them. One cheap count per cycle, never per batch; a failing
    // count is reported, never fatal (the drain already owns the backoff).
    try {
      const deadLettered = await ingestFailureRepository.countUnresolved();

      if (deadLettered > 0) {
        console.warn(
          `Trace ingestion worker: ${deadLettered} trace(s) parked in the dead-letter trail ` +
            "(ingest_failures) — recover them with the README's Day-2 runbook.",
        );
      }
    } catch (error) {
      console.warn(
        `Trace ingestion worker: dead-letter count unavailable this cycle: ${String(error)}`,
      );
    }

    // Periodic reprocess sweep (decision 63: also triggered directly by
    // the price-insert job; this is the backstop cadence). Runs on its
    // OWN cadence regardless of drain success (audit B-3): a stalled
    // drain must not starve pending re-stamps.
    if (
      !stopping &&
      Date.now() - lastReprocessAt >= traceIngestionWorkerSettings.reprocessIntervalMs
    ) {
      try {
        await makeReprocessPendingUseCase().reprocess();
        lastReprocessAt = Date.now();
      } catch (error) {
        console.error(
          `Trace ingestion worker: reprocess sweep failed (next cadence retries): ` +
            `${String(error)}`,
        );
      }
    }

    if (drainFailed) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, TRANSIENT_BACKOFF_CAP_MS);
      continue;
    }

    if (!stopping) {
      await sleep(traceIngestionWorkerSettings.intervalMs);
    }
  }

  console.log('Trace ingestion worker: stopped cleanly.');
};

const database = makeDatabase();

await database.connect();

try {
  await runWorker();
} finally {
  await database.disconnect();
}
