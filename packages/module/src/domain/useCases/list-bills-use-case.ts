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
  /**
   * Closed months: the SNAPSHOT total, verbatim (T7 — matches the frozen
   * statement forever). Open months: live sum of the stamps.
   */
  totalCostMicrocents: number;
  stampedTraceCount: number;
  /**
   * Open months: live count, EXCLUDING pending traces with unresolved
   * quarantine (decision 100 — those show in quarantinedTraceCount).
   * Closed months served purely from the snapshot report 0 here: a
   * pending trace can only reach a closed month as a post-close arrival,
   * which the quarantine count carries.
   */
  pendingTraceCount: number;
  /**
   * audit B-10.4 — the "month volume so far" number: all token types
   * summed over stamped AND pending traces (open-month live meaning;
   * pending traces with unresolved quarantine excluded, decision 100).
   * Closed months fill this from the snapshot, so there tokens ===
   * stampedTokens (the frozen bill knows only billed volume).
   */
  tokens: number;
  /**
   * audit B-10.4 — the BILLED volume: token sum of stamped traces only.
   * Closed months: the snapshot's stampedTokensTotal, verbatim.
   */
  stampedTokens: number;
  /** Present iff periodStatus === 'closed'. */
  closedAt?: Date;
  snapshotVersion?: number;
  /** Traces with UNRESOLVED quarantine (decision 100) — admin visibility (US5). */
  quarantinedTraceCount: number;
}

export interface ListBillsUseCase {
  /** Bills ordered most recent first. */
  list(): Promise<BillListItem[]>;
}
