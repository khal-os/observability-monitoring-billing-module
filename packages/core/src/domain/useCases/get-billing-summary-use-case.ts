import { TokenCounts } from '../models/trace-model.js';
import { StatementProjection } from '../models/billing-snapshot-model.js';
import { BillingPeriodStatus } from '../models/billing-period-model.js';

export type { BillingPeriodStatus } from '../models/billing-period-model.js';

/** Pending traces are reported APART — never inside the R$ total (invariant 2). */
export interface PendingPriceSummary {
  traceCount: number;
  tokens: TokenCounts;
  models: string[];
}

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
  /**
   * Traces whose LLM reported no measured usage (decision 128) — a live
   * CONTEXT count like quarantinedTraceCount, never a statement input:
   * these traces are outside every R$ total by construction.
   */
  noMeasuredUsageTraceCount: number;
  comparison: BillingMonthComparison | null;
}

export interface GetBillingSummaryUseCase {
  /** Calendar month in UTC: year (e.g. 2026) + month (1-12). */
  get(year: number, month: number): Promise<BillingSummary>;
}
