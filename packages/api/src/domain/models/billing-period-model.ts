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
 */
export type BillingPeriodStatus = 'closed' | 'in_progress' | 'open';

/**
 * THE period-status rule (invariant 8's label logic), stated once: a
 * lifecycle-closed month is 'closed'; otherwise the current UTC calendar
 * month is 'in_progress' (always partial) and any other month is 'open'.
 * Absence of a period document means the month was never closed.
 */
export const resolvePeriodStatus = (
  year: number,
  month: number,
  period: Pick<BillingPeriodModel, 'status'> | null | undefined,
  now: Date,
): BillingPeriodStatus => {
  if (period?.status === 'closed') return 'closed';

  return year === now.getUTCFullYear() && month === now.getUTCMonth() + 1
    ? 'in_progress'
    : 'open';
};

/** The billing period IS the UTC calendar month (invariant 8) — half-open window. */
export const monthWindowUtc = (
  year: number,
  month: number,
): { start: Date; end: Date } => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
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
 * audit C-7.1: the live-scan bound — UTC start of the earliest month NOT
 * closed. Live aggregations (bill list, monthly rollup) scan only from
 * here; everything before is closed history, served from period docs +
 * snapshots, so scanning its full-content trace documents on every read
 * was pure waste at archive scale.
 *
 * Derivation: walk forward from the EARLIEST closed month; the first
 * non-closed month (a gap, or a reopened month) is the bound. No closed
 * month ⇒ null (unbounded — today's behavior). Assumes the runbook's
 * oldest-first close discipline: a never-closed month OLDER than the
 * earliest closed one would fall outside the scan.
 */
export const firstOpenMonthStart = (
  periods: BillingPeriodModel[],
): Date | null => {
  const closed = periods.filter((period) => period.status === 'closed');

  if (closed.length === 0) return null;

  const closedKeys = new Set(
    closed.map((period) => `${period.year}-${period.month}`),
  );
  const earliest = [...closed].sort(
    (a, b) => a.year - b.year || a.month - b.month,
  )[0] as BillingPeriodModel;

  let { year, month } = earliest;

  while (closedKeys.has(`${year}-${month}`)) {
    month += 1;

    if (month === 13) {
      month = 1;
      year += 1;
    }
  }

  return new Date(Date.UTC(year, month - 1, 1));
};
