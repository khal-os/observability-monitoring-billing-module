import { TokenType } from '../models/price-version-model.js';
import { TokenCounts } from '../models/trace-model.js';
import { StatementProjection } from '../models/billing-snapshot-model.js';

/**
 * One line of the month breakdown: agent × agent version × model × token
 * type × applied unit price (decisions 48/90), where cost is the SUM of
 * ingestion-time stamps (invariant 3 — never an independent calculation
 * path). Null agent/version/model = traces without that attribution,
 * shown honestly. The full line shape (with unit prices and reconciled
 * display cents) lives in the engine's StatementLine; this slim shape
 * remains for callers that only need the dimensions.
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

/**
 * 'closed' = month frozen by T6, served from its snapshot, labeled final.
 * 'in_progress' = current calendar month, always partial (invariant 8).
 * 'open' = past month not yet closed.
 */
export type BillingPeriodStatus = 'closed' | 'in_progress' | 'open';

/** US10: the month side by side with the previous one — informative only in v1. */
export interface BillingMonthComparison {
  previousYear: number;
  previousMonth: number;
  previousPeriodStatus: BillingPeriodStatus;
  previousTotalCostMicrocents: number;
  /** Current − previous; negative = the month got cheaper. */
  totalDeltaMicrocents: number;
  byAgent: {
    agentId: string | null;
    agentVersion: string | null;
    currentCostMicrocents: number;
    previousCostMicrocents: number;
    deltaMicrocents: number;
  }[];
}

/** US5: reopen history surfaced with the statement (audit note per action). */
export interface BillingReopenNote {
  at: Date;
  reason: string;
}

/**
 * The month statement (T7). For a closed month every numeric field inside
 * `statement` comes VERBATIM from the snapshot — never recomputed; for an
 * open month the same engine computes it live from the stamps. Comparison
 * is derived at read time from the two months' (frozen or live) totals —
 * it references another month, so it never belongs inside a snapshot.
 */
export interface BillingSummary {
  year: number;
  /** 1-12. */
  month: number;
  periodStatus: BillingPeriodStatus;
  statement: StatementProjection;
  pendingPrice: PendingPriceSummary;
  /** Data-freshness watermark (US2/US6): closed → frozen; open → live max ingestedAt. */
  ingestionWatermark: Date | null;
  /** Present iff periodStatus === 'closed'. */
  closedAt?: Date;
  snapshotVersion?: number;
  /** Every close version that exists for the month (US5 — reopened months keep all). */
  snapshotVersions?: { version: number; createdAt: Date }[];
  reopenNotes: BillingReopenNote[];
  /** Traces that arrived after the close, quarantined (T6) — admin visibility. */
  quarantinedTraceCount: number;
  comparison: BillingMonthComparison | null;
}

export interface GetBillingSummaryUseCase {
  /** Calendar month in UTC: year (e.g. 2026) + month (1-12). */
  get(year: number, month: number): Promise<BillingSummary>;
}
