import {
  billingCloseSchedulerSettings,
  makeCloseDueBillingPeriodsUseCase,
} from '../factories/billing-factory.js';
import { makeDatabase } from '../factories/database-factory.js';
import { beatSchedulerHeartbeat } from './billing-scheduler-heartbeat.js';
import { formatCloseSuccess } from './helpers/format-close-result.js';
import { clientTimezone } from '@observability/core/common/helpers/clock/client-clock.js';

/**
 * T6 continuous form (decision 131) — the billing-close-scheduler
 * sidecar's entry point. A reconcile loop, NOT a cron: every wake it asks
 * "is any fully-past client-calendar month still open past its safety
 * delay?" and closes what it finds, oldest first, through the ONE close
 * use case (trigger 'scheduled'). Re-evaluating state instead of firing
 * at a computed instant is what makes downtime catch-up, blocked-retry
 * and DST transitions non-events.
 *
 * The sidecar only EXISTS when the client env opts in via the
 * `billing-auto-close` compose profile — absent knob, absent container
 * (declared, never inferred). Its stdout is the US5 notification, same
 * as the runbook's.
 *
 * Shutdown contract: SIGTERM/SIGINT set a flag checked BETWEEN cycles —
 * an in-flight close finishes (the close itself publishes atomically, so
 * even a SIGKILL mid-close leaves nothing readable; the next wake retries
 * cleanly).
 */
let stopping = false;
let wake: (() => void) | undefined;

const requestStop = (signal: string): void => {
  console.log(`Billing close scheduler: ${signal} received — finishing current cycle.`);
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
 * Steady-state lines (waiting / reopened hold) REPEAT at most hourly, but
 * a steady-state TRANSITION always logs immediately: entering the
 * reopened hold right after a waiting line is news, and the live
 * verification of decision 131 caught a shared timestamp swallowing it
 * for the rest of the hour.
 */
const STEADY_STATE_LOG_INTERVAL_MS = 3_600_000;

/**
 * The scheduler's body, extracted so every exit path leaves through the
 * caller's `finally` (the worker-loop convention).
 */
const runScheduler = async (): Promise<void> => {
  // audit F-4: the resolved knobs in the first lines of the log — a
  // misconfigured knob must be visible without reading compose.
  console.log(
    `Billing close scheduler: started (fecha ${billingCloseSchedulerSettings.delayMs / 60_000}min ` +
      `após a meia-noite do cliente, verificação a cada ` +
      `${billingCloseSchedulerSettings.checkIntervalMs / 1000}s, fuso ${clientTimezone()}).`,
  );

  const runner = makeCloseDueBillingPeriodsUseCase();

  let backoffMs = TRANSIENT_BACKOFF_BASE_MS;
  let lastSteadyState = '';
  let lastSteadyStateLogAt = 0;

  const logSteadyState = (key: string, line: string): void => {
    if (
      key !== lastSteadyState ||
      Date.now() - lastSteadyStateLogAt >= STEADY_STATE_LOG_INTERVAL_MS
    ) {
      console.log(line);
      lastSteadyState = key;
      lastSteadyStateLogAt = Date.now();
    }
  };

  while (!stopping) {
    let cycleFailed = false;

    try {
      const report = await runner.runCycle();

      // Progress, not process existence (audit G-1): only a COMPLETED
      // cycle beats — a blocked close is a completed decision and beats
      // too; error paths fall through without beating, so a hung Mongo
      // socket ages the heartbeat and the container turns unhealthy.
      beatSchedulerHeartbeat();

      for (const closed of report.closed) {
        for (const line of formatCloseSuccess(closed)) {
          console.log(line);
        }
      }

      for (const raced of report.racedAlreadyClosed) {
        console.log(
          `Billing close scheduler: mês ${raced.year}-${String(raced.month).padStart(2, '0')} ` +
            'já fechado por outra porta (runbook concorrente) — nada a fazer.',
        );
      }

      if (report.blocked) {
        // QA5's answer (decision 131): the bill WAITS — every cycle
        // re-attempts and re-lists what is missing, and the moment the
        // price lands (its registration re-stamps pending traces) the
        // next cycle closes the month with no second manual step.
        console.error(
          `✖ ${report.blocked.message} Nova tentativa em ` +
            `${billingCloseSchedulerSettings.checkIntervalMs / 1000}s.`,
        );
      } else if (report.reopenedHold) {
        const { year, month } = report.reopenedHold;

        logSteadyState(
          `hold:${year}-${month}`,
          `Billing close scheduler: mês ${year}-${String(month).padStart(2, '0')} está ` +
            'REABERTO — fechamento automático suspenso (a correção é de quem reabriu); ' +
            'feche via make billing-close quando terminar.',
        );
      } else if (report.closed.length === 0 && report.racedAlreadyClosed.length === 0) {
        const candidate = report.nextCandidate;

        logSteadyState(
          candidate ? `waiting:${candidate.year}-${candidate.month}` : 'waiting:empty',
          candidate
            ? `Billing close scheduler: nada a fechar — próximo candidato ` +
                `${candidate.year}-${String(candidate.month).padStart(2, '0')}, ` +
                `elegível em ${candidate.eligibleAt.toISOString()}.`
            : 'Billing close scheduler: nada a fechar — nenhum trace no arquivo ainda.',
        );
      }

      if (report.closed.length > 0 || report.blocked) {
        // Something happened — the next steady-state line is news again.
        lastSteadyState = '';
      }

      backoffMs = TRANSIENT_BACKOFF_BASE_MS; // healthy cycle → reset
    } catch (error) {
      console.error(
        `Billing close scheduler: cycle failed (retrying in ${backoffMs / 1000}s): ` +
          `${String(error)}`,
      );
      cycleFailed = true;
    }

    if (cycleFailed) {
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, TRANSIENT_BACKOFF_CAP_MS);
      continue;
    }

    if (!stopping) {
      await sleep(billingCloseSchedulerSettings.checkIntervalMs);
    }
  }

  console.log('Billing close scheduler: stopped cleanly.');
};

const database = makeDatabase();

await database.connect();

try {
  await runScheduler();
} finally {
  await database.disconnect();
}
