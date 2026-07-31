import {
  BillingSummaryLine,
  PendingPriceSummary,
} from '../../domain/useCases/get-billing-summary-use-case.js';
import { BillingUsageRecord } from '../../domain/models/billing-snapshot-model.js';
import { CostByTokenType } from '../../domain/useCases/get-billing-series-use-case.js';

/** One month of the live rollup (T8): sums of stamps, grouped as stored. */
export interface MonthlyRollupRow {
  year: number;
  month: number;
  totalCostMicrocents: number;
  byTokenType: CostByTokenType;
  byAgent: {
    agentId: string | null;
    costMicrocents: number;
    byTokenType: CostByTokenType;
  }[];
  byModel: {
    model: string | null;
    costMicrocents: number;
    byTokenType: CostByTokenType;
  }[];
}

/** One UTC day of the live rollup — same stamps, daily bucket. */
export interface DailyRollupRow {
  /** UTC midnight. */
  date: Date;
  totalCostMicrocents: number;
  byTokenType: CostByTokenType;
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
   * Pending-price rollup of the month window [monthStart, monthEnd) —
   * counted APART from the total, never inside it (invariant 2).
   */
  pendingPriceSummary(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<PendingPriceSummary>;

  /**
   * One bill per UTC calendar month that has at least one trace, most
   * recent first. Totals are sums of the SAME ingestion-time stamps
   * aggregateMonth reads (one store, one truth).
   */
  listBills(): Promise<BillRow[]>;

  /**
   * The statement engine's diet for one month: one record per STAMPED
   * trace of [monthStart, monthEnd), stamps copied verbatim, payloads and
   * spans never loaded (decision 47). Deterministic order (traceId).
   */
  fetchUsageRecords(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BillingUsageRecord[]>;

  /**
   * Monthly cost rollup across all months with stamped traces (T8 live
   * side): totals plus per-agent and per-model sums of the same stamps,
   * each with its token-type split.
   */
  monthlyRollup(): Promise<MonthlyRollupRow[]>;

  /**
   * Daily cost rollup over [from, toExclusive), UTC-day buckets, token-type
   * split. EXCLUDES quarantined traces — the days of a closed month must
   * sum to its frozen bill (decision 97).
   */
  dailyRollup(from: Date, toExclusive: Date): Promise<DailyRollupRow[]>;

  /** Max ingestedAt among the month's traces (freshness watermark), or null. */
  ingestionWatermark(monthStart: Date, monthEnd: Date): Promise<Date | null>;

  /**
   * Traces of the month that arrived AFTER its close and were quarantined
   * (T6 post-close rule) — admin visibility count (US5).
   */
  countQuarantined(monthStart: Date, monthEnd: Date): Promise<number>;

  /** Total stamped cost accrued in [monthStart, upTo) — the projection's numerator (US12). */
  accruedCostMicrocents(monthStart: Date, upTo: Date): Promise<number>;
}
