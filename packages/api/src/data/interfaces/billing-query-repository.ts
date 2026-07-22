import {
  BillingSummaryLine,
  PendingPriceSummary,
} from '../../core/useCases/get-billing-summary-use-case.js';

export interface BillingMonthAggregate {
  lines: BillingSummaryLine[];
  pendingPrice: PendingPriceSummary;
}

/** Raw bill row (one UTC calendar month) — period status is the use case's call. */
export interface BillRow {
  year: number;
  month: number;
  totalCostMicrocents: number;
  stampedTraceCount: number;
  pendingTraceCount: number;
  tokens: number;
}

export interface BillingQueryRepository {
  /**
   * Aggregates the month window [monthStart, monthEnd) STRICTLY from the
   * stamped costs stored on traces — same collection, same stamp the
   * traces/sessions tabs read (one store, one truth).
   */
  aggregateMonth(monthStart: Date, monthEnd: Date): Promise<BillingMonthAggregate>;

  /**
   * One bill per UTC calendar month that has at least one trace, most
   * recent first. Totals are sums of the SAME ingestion-time stamps
   * aggregateMonth reads (one store, one truth).
   */
  listBills(): Promise<BillRow[]>;
}
