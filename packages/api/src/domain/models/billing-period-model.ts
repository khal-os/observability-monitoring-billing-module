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
