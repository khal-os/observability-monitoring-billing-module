import {
  BillingCloseBlockedError,
  BillingPeriodRepository,
  BillingPeriodStateError,
  BillingQueryRepository,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
} from './billing-lifecycle-protocols.js';
import { monthWindow } from '@observability/core/domain/models/billing-period-model.js';
import { clientCalendarOf } from '@observability/core/common/helpers/clock/client-clock.js';

/**
 * One evaluation cycle of the auto-close scheduler (decision 131), as
 * data — the loop entry point prints, this decides. Print-free so the
 * walk is unit-testable and the two doors (runbook, scheduler) share one
 * vocabulary of outcomes.
 */
export interface AutoCloseCycleReport {
  /** Months closed this cycle, oldest first (downtime catch-up closes several). */
  closed: CloseBillingPeriodResult[];
  /**
   * The oldest due month that refused to close (pending_price, or the
   * close-order guard naming an older month). The walk stops here —
   * oldest-first means nothing newer may pass it — and the next cycle
   * retries (QA5's answer: the bill WAITS).
   */
  blocked?: {
    year: number;
    month: number;
    pendingTraceCount: number;
    modelsWithoutPrice: string[];
    message: string;
  };
  /**
   * A due month an operator reopened. The scheduler NEVER re-closes it —
   * the reopen's correction flow (decision 89) belongs to the human who
   * started it — and holds everything newer too (close order).
   */
  reopenedHold?: { year: number; month: number };
  /** Months a concurrent runbook close won while this cycle ran — benign. */
  racedAlreadyClosed: { year: number; month: number }[];
  /** The next month to become eligible, and the instant it does. */
  nextCandidate?: { year: number; month: number; eligibleAt: Date };
}

/**
 * The scheduler's reconcile walk (decision 131): from the earliest stored
 * trace's client-calendar month forward, every month whose window ended at
 * least `delayMs` ago is DUE — closed months are skipped, trace-free gap
 * months are skipped (the same exemption the close-order guard grants),
 * a reopened month halts the walk, and the first due month standing is
 * closed through the ONE close use case (composed behind this runner with
 * trigger 'scheduled'). Re-evaluating the whole predicate every wake is
 * what makes downtime catch-up, blocked-retry and DST handling fall out
 * for free — there is no next-fire instant to get wrong, only state to
 * converge on.
 *
 * `delayMs` exists because the store trails live by the ingestion quiet
 * period + poll interval (~16 min, decisions 60/61): a midnight-sharp
 * close would quarantine the month's last minutes every single month.
 * Correctness never depends on it (decision 100 adjudicates stragglers);
 * it only keeps the quarantine ledger quiet.
 */
export class CloseDueBillingPeriodsDbUseCase {
  private readonly billingPeriodRepository: Pick<BillingPeriodRepository, 'listAll'>;
  private readonly billingQueryRepository: Pick<
    BillingQueryRepository,
    'earliestTraceAt' | 'hasTraces'
  >;
  private readonly closeBillingPeriod: CloseBillingPeriodUseCase;
  private readonly delayMs: number;
  private readonly now: () => Date;

  constructor(args: {
    billingPeriodRepository: Pick<BillingPeriodRepository, 'listAll'>;
    billingQueryRepository: Pick<
      BillingQueryRepository,
      'earliestTraceAt' | 'hasTraces'
    >;
    closeBillingPeriod: CloseBillingPeriodUseCase;
    delayMs: number;
    now?: () => Date;
  }) {
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingQueryRepository = args.billingQueryRepository;
    this.closeBillingPeriod = args.closeBillingPeriod;
    this.delayMs = args.delayMs;
    this.now = args.now ?? (() => new Date());
  }

  async runCycle(): Promise<AutoCloseCycleReport> {
    const report: AutoCloseCycleReport = { closed: [], racedAlreadyClosed: [] };
    const now = this.now();

    const earliest = await this.billingQueryRepository.earliestTraceAt();

    // Empty store: no month can ever be due before a trace exists, and
    // there is no calendar anchor to walk from — report "waiting".
    if (!earliest) return report;

    const periods = await this.billingPeriodRepository.listAll();
    const closedKeys = new Set(
      periods
        .filter((period) => period.status === 'closed')
        .map((period) => `${period.year}-${period.month}`),
    );
    // A period document with status 'open' exists ONLY via an audited
    // reopen (absence of a document is the implicit open state).
    const reopenedKeys = new Set(
      periods
        .filter((period) => period.status === 'open')
        .map((period) => `${period.year}-${period.month}`),
    );

    const earliestCalendar = clientCalendarOf(earliest);
    let year = earliestCalendar.year;
    let month = earliestCalendar.month;

    // Same month-ordinal walk as the close-order guard: one iteration per
    // calendar month of history, probes only where needed.
    for (;;) {
      const window = monthWindow(year, month);
      const eligibleAt = new Date(window.end.getTime() + this.delayMs);

      // The current (and any future) month always lands here: its window
      // has not ended, let alone aged past the delay.
      if (eligibleAt.getTime() > now.getTime()) {
        report.nextCandidate = { year, month, eligibleAt };
        break;
      }

      const key = `${year}-${month}`;

      if (reopenedKeys.has(key)) {
        report.reopenedHold = { year, month };
        break;
      }

      if (
        !closedKeys.has(key) &&
        (await this.billingQueryRepository.hasTraces(window.start, window.end))
      ) {
        try {
          report.closed.push(await this.closeBillingPeriod.close(year, month));
        } catch (error) {
          if (error instanceof BillingCloseBlockedError) {
            report.blocked = {
              year,
              month,
              pendingTraceCount: error.pendingTraceCount,
              modelsWithoutPrice: error.modelsWithoutPrice,
              message: error.message,
            };
            break;
          }

          if (error instanceof BillingPeriodStateError) {
            // Only two shapes reach here for a due month: a concurrent
            // close won the guarded flip, or the month was already closed
            // between listAll and the attempt. Both mean "closed by the
            // other door" — benign, keep walking.
            report.racedAlreadyClosed.push({ year, month });
          } else {
            throw error;
          }
        }
      }

      month += 1;

      if (month === 13) {
        month = 1;
        year += 1;
      }
    }

    return report;
  }
}
