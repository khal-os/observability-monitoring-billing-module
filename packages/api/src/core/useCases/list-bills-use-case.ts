import { BillingPeriodStatus } from './get-billing-summary-use-case.js';

/**
 * One bill (fatura) per UTC calendar month that has ANY trace — stamped or
 * pending (billing period = calendar month, invariant 8). The total is the
 * sum of ingestion-time stamps of that month (invariant 3); pending traces
 * are counted apart and never inside the total (invariant 2).
 */
export interface BillListItem {
  year: number;
  /** 1-12. */
  month: number;
  periodStatus: BillingPeriodStatus;
  totalCostMicrocents: number;
  stampedTraceCount: number;
  pendingTraceCount: number;
  /** All token types summed, stamped and pending traces alike. */
  tokens: number;
}

export interface ListBillsUseCase {
  /** Bills ordered most recent first. */
  list(): Promise<BillListItem[]>;
}
