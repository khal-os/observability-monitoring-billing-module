/**
 * Billing period lifecycle (T6): a UTC calendar month is 'open' until an
 * explicit close, then 'closed' (frozen, served from its snapshot). A
 * period document exists only once a lifecycle action touched the month —
 * absence means open (the PoC behavior, unchanged).
 *
 * Reopening is an audited runbook action (T6): status returns to 'open',
 * every prior snapshot version is preserved, and the next close writes
 * version + 1. `audit` is append-only.
 */
export type BillingPeriodLifecycleStatus = 'open' | 'closed';

export interface BillingPeriodAuditEntry {
  at: Date;
  action: 'close' | 'reopen';
  /** v1: lifecycle actions exist only as runbook jobs (decision 87). */
  trigger: 'runbook';
  /** Required on reopen (T6: audited) — absent on close. */
  reason?: string;
  /** The snapshot version the action produced (close) or set aside (reopen). */
  snapshotVersion: number;
}

export interface BillingPeriodModel {
  year: number;
  /** 1-12. */
  month: number;
  status: BillingPeriodLifecycleStatus;
  /** Present iff status === 'closed'. */
  closedAt?: Date;
  /** Current snapshot version (highest ever written for the month). */
  snapshotVersion?: number;
  audit: BillingPeriodAuditEntry[];
}

/**
 * 'closed' = month frozen by T6, served from its snapshot, labeled final.
 * 'in_progress' = current calendar month, always partial (invariant 8).
 * 'open' = past month not yet closed.
 * 'future' = month after the current one (audit B-1): reachable because
 *   the ingest boundary admits future started_at timestamps (source clock
 *   skew, a mis-instrumented agent). Never served as a bill — the summary
 *   400s it, /bills excludes it, the series never charts past the current
 *   month. INTERNAL value: it must not reach the wire (the response
 *   enums stay closed/in_progress/open by construction).
 */
export type BillingPeriodStatus = 'closed' | 'in_progress' | 'open' | 'future';

/**
 * THE period-status rule (invariant 8's label logic), stated once: a
 * lifecycle-closed month is 'closed'; otherwise the current UTC calendar
 * month is 'in_progress' (always partial), a later month is 'future'
 * (audit B-1 — this rule used to live in ONE of the three readers, so
 * /bills listed a month /billing/summary 400'd: two readers of one truth
 * disagreeing about whether the month exists), and any other month is
 * 'open'. Absence of a period document means the month was never closed;
 * a lifecycle-closed FUTURE month is impossible (the close guard refuses
 * months that have not fully passed).
 */
export const resolvePeriodStatus = (
  year: number,
  month: number,
  period: Pick<BillingPeriodModel, 'status'> | null | undefined,
  now: Date,
): BillingPeriodStatus => {
  if (period?.status === 'closed') return 'closed';

  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;

  if (year === nowYear && month === nowMonth) return 'in_progress';

  if (year > nowYear || (year === nowYear && month > nowMonth)) {
    return 'future';
  }

  return 'open';
};

/** The billing period IS the UTC calendar month (invariant 8) — half-open window. */
export const monthWindowUtc = (
  year: number,
  month: number,
): { start: Date; end: Date } => {
  // Year bounds are correctness, not pedantry (audit B-2): Date.UTC maps
  // years 0-99 into 1900-1999, so monthWindowUtc(26, 6) silently produced
  // the 1926 window — and a close over it SUCCEEDED (fully past, empty,
  // pending-free), leaving a period document that anchored the
  // decision-119 live-scan bound at 1926 forever. Same bounds as the HTTP
  // door's yearMonthQueryShape and the runbook's parseRunbookYearMonth.
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    year < 1970 ||
    year > 9999 ||
    month < 1 ||
    month > 12
  ) {
    throw new Error(`Invalid billing period: year=${year}, month=${month}`);
  }

  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
};

export const previousMonthOf = (
  year: number,
  month: number,
): { year: number; month: number } =>
  month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

/**
 * UTC windows of every lifecycle-CLOSED month — the scope where the
 * daily rollup's unresolved-quarantine exclusion applies (decision 97:
 * the days of a frozen month must sum to its frozen bill; in a reopened
 * or never-closed month the straggler is part of the LIVE total, so its
 * days must chart). Stated once so the series use case and the tests
 * derive the same windows from the same periods.
 */
export const closedMonthWindows = (
  periods: BillingPeriodModel[],
): { start: Date; end: Date }[] =>
  periods
    .filter((period) => period.status === 'closed')
    .map((period) => monthWindowUtc(period.year, period.month));

/**
 * audit C-7.1: the live-scan bound — UTC start of the earliest month whose
 * money the live readers still have to compute. Live aggregations (bill
 * list, monthly rollup) scan only from here; everything before is closed
 * history, served from period docs + snapshots, so scanning its
 * full-content trace documents on every read was pure waste at archive
 * scale.
 *
 * THE PROPERTY THIS FUNCTION PROVIDES — the one every caller leans on:
 * every month that is NOT lifecycle-closed and holds at least one trace
 * starts at or after the returned bound. The live scan therefore can
 * never drop a month that carries money, whatever the lifecycle history.
 * Proof, in the order the code computes it, for any non-closed
 * trace-bearing month M:
 * (i)   the walk's ANCHOR is the earlier of the earliest closed month and
 *       the month of the EARLIEST STORED TRACE, so anchor ≤ M;
 * (ii)  the walk steps only over CLOSED months, so it stops at the first
 *       non-closed month at or after the anchor — at or before M;
 * (iii) the result is the minimum of that walk and the earliest
 *       non-closed period document, so result ≤ walk ≤ M.
 *
 * No closed month ⇒ null (unbounded — today's behavior).
 *
 * `earliestTraceAt` is REQUIRED, positional and un-defaulted (re-audit
 * iteration 3) because the property above CANNOT be derived from the
 * period documents alone, and a caller that forgets it must not compile:
 * a month no lifecycle action ever touched has NO period document
 * (markClosed/markReopened are the only writers), so it is invisible both
 * to the closed set and to the non-closed set. Three variants of that one
 * defect were filed and each earlier fix patched one shape — a never
 * closed month inside a closed run (decision 112), a REOPENED earliest
 * month (decision 114), and a never-closed month BEFORE the earliest
 * closed one. Anchoring the walk on the data closes the class: (i) holds
 * for every month with a trace in it, document or no document.
 *
 * The close-order guard (assertOlderMonthsClosed, decision 112) does NOT
 * make the third variant impossible, and the comment that asserted so was
 * simply wrong: the guard is a point-in-time check inside close(), so it
 * constrains the close INSTANT only. A later ingest always recreates the
 * state — a backfill over a never-closed month (`make sync FROM=… TO=…`,
 * README's dead-letter recovery) is a documented Day-2 operation, and
 * ingestion quarantines a late trace only when ITS OWN month is closed.
 *
 * Half (b) — the earliest non-closed period document — is subsumed by the
 * anchor and stays as a tightening: it can only move the bound EARLIER,
 * never later, so it can never hide money, and it keeps a reopened month
 * inside the scan even when the store holds no trace at all.
 */
export const firstOpenMonthStart = (
  periods: BillingPeriodModel[],
  earliestTraceAt: Date | null,
): Date | null => {
  const closed = periods.filter((period) => period.status === 'closed');

  if (closed.length === 0) return null;

  const closedKeys = new Set(
    closed.map((period) => `${period.year}-${period.month}`),
  );
  const earliestClosed = [...closed].sort(
    (a, b) => a.year - b.year || a.month - b.month,
  )[0] as BillingPeriodModel;

  // The anchor is the earliest month that can carry money. A stored trace
  // older than the earliest closed month means an OPEN month with no
  // period document to betray it, so only the data can put the walk there.
  const anchor =
    earliestTraceAt &&
    Date.UTC(
      earliestTraceAt.getUTCFullYear(),
      earliestTraceAt.getUTCMonth(),
      1,
    ) < Date.UTC(earliestClosed.year, earliestClosed.month - 1, 1)
      ? {
          year: earliestTraceAt.getUTCFullYear(),
          month: earliestTraceAt.getUTCMonth() + 1,
        }
      : earliestClosed;

  let { year, month } = anchor;

  while (closedKeys.has(`${year}-${month}`)) {
    month += 1;

    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  const reopenedStarts = periods
    .filter((period) => period.status !== 'closed')
    .map((period) => Date.UTC(period.year, period.month - 1, 1));

  // Math.min over an empty spread is Infinity, so the walk still decides
  // when every period document is closed.
  return new Date(Math.min(Date.UTC(year, month - 1, 1), ...reopenedStarts));
};
