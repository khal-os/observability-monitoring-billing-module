import { TokenType } from '../models/price-version-model.js';
import { TokenCounts } from '../models/trace-model.js';

/**
 * One line of the month breakdown: agent × agent version × model × token
 * type (decision 48 — cost per release visible in the statement), where
 * cost is the SUM of ingestion-time stamps (invariant 3 — never an
 * independent calculation path). Null agent/version/model = traces without
 * that attribution, shown honestly.
 */
export interface BillingSummaryLine {
  agentId: string | null;
  agentVersion: string | null;
  model: string | null;
  tokenType: TokenType;
  tokens: number;
  costMicrocents: number;
}

/** Pending traces are reported APART — never inside the R$ total (invariant 2). */
export interface PendingPriceSummary {
  traceCount: number;
  tokens: TokenCounts;
  models: string[];
}

export type BillingPeriodStatus = 'in_progress' | 'open';

export interface BillingSummary {
  year: number;
  /** 1-12. */
  month: number;
  /**
   * 'in_progress' = current calendar month, always partial (invariant 8).
   * 'open' = past month, not closed — month close/snapshot (T6) is out of
   * the PoC; nothing is ever labeled final here.
   */
  periodStatus: BillingPeriodStatus;
  totalCostMicrocents: number;
  lines: BillingSummaryLine[];
  pendingPrice: PendingPriceSummary;
}

export interface GetBillingSummaryUseCase {
  /** Calendar month in UTC: year (e.g. 2026) + month (1-12). */
  get(year: number, month: number): Promise<BillingSummary>;
}
