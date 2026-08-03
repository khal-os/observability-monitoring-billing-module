import {
  makeReprocessPendingUseCase,
  makeSyncBatchesUseCase,
  traceIngestionWorkerSettings,
} from '../factories/sync-factory.js';
import { makeDatabase } from '../factories/database-factory.js';

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

const database = makeDatabase();

await database.connect();

try {
  const batchSync = makeSyncBatchesUseCase();

  if (!batchSync) {
    // Pre-onboarding / offline-demo stack: no ClickHouse source to page.
    // Idle instead of exiting — an exit would just crash-loop the service.
    console.log(
      'Trace ingestion worker: continuous-sync source not configured (see clients/example.env) — idling. ' +
        'Fixture-backed demos keep using `make sync`.',
    );

    while (!stopping) {
      await sleep(3600_000);
    }

    process.exit(0);
  }

  // Fatal by design: never sync through an unverified source schema.
  await batchSync.source.assertCompatibleSchema();

  console.log(
    `Trace ingestion worker: started (interval ${traceIngestionWorkerSettings.intervalMs / 1000}s, ` +
      `reprocess every ${traceIngestionWorkerSettings.reprocessIntervalMs / 1000}s).`,
  );

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
} finally {
  await database.disconnect();
}
