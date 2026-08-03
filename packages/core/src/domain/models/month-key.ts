import { BillingPeriodModel } from './billing-period-model.js';

/** Month key shared by the sync loops and the reprocess sweep — `${UTC year}-${UTC month}`. */
export const monthKeyOf = (date: Date): string =>
  `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;

/**
 * audit C-7.3: closed months are resolved ONCE per sync cycle (one
 * listAll) and passed into every ingest — the per-trace period lookup was
 * an N+1 on the hot path (1000 lookups per batch).
 *
 * re-audit 2026-08 (sync item 5): a set read at cycle start CAN go stale
 * (a close landing mid-cycle, or mid-backfill). What actually keeps that
 * honest is three layers, not one — the earlier "fully safe" claim
 * overstated it:
 *   1. ingest re-checks the period for the rare PAST-month trace (see
 *      trace-ingestor), so a straggler dated in the month that just closed
 *      is flagged at write time;
 *   2. the close-side reconciliation (audit B-1 / decision 100) flags any
 *      straggler that still slipped through before the close committed;
 *   3. a crashed reconcile is repaired on the next close of that month —
 *      the already-closed retry path runs it again.
 * A current-month trace ingested while its own month is being closed is
 * layer 2's business; layer 1 deliberately does not pay a lookup for it.
 */
export const closedMonthKeys = (periods: BillingPeriodModel[]): Set<string> =>
  new Set(
    periods
      .filter((period) => period.status === 'closed')
      .map((period) => `${period.year}-${period.month}`),
  );
