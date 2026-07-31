import { BillingPeriodStatus } from './get-billing-summary-use-case.js';
import { TokenType } from '../models/price-version-model.js';

/** Cost split by token type — the statement's line colors, on the chart. */
export type CostByTokenType = { tokenType: TokenType; costMicrocents: number }[];

/**
 * T8: the monthly cost series — ONE total per month, everywhere: closed
 * months come from their snapshots (matching the statement forever, US11),
 * open months from the live stamp sums, the current month labeled
 * in_progress. History starts shallow (≈49-day backfill) and fattens.
 * Every slice carries its token-type split so bars can stack.
 */
export interface BillingSeriesMonth {
  year: number;
  month: number;
  periodStatus: BillingPeriodStatus;
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

/**
 * The daily lens: sums of the SAME stamps, bucketed by UTC day. Today is
 * always partial. Quarantined traces are excluded, so the days of a
 * closed month sum exactly to its frozen bill. An operational/analytics
 * view — the invoice remains monthly.
 */
export interface BillingSeriesDay {
  /** UTC midnight of the day. */
  date: Date;
  periodStatus: BillingPeriodStatus;
  /** True only for today (UTC) — the day is still accruing. */
  partial: boolean;
  totalCostMicrocents: number;
  byTokenType: CostByTokenType;
}

export interface GetBillingSeriesUseCase {
  /** Chronological (oldest first), capped at `maxMonths` most recent months. */
  list(maxMonths: number): Promise<BillingSeriesMonth[]>;

  /** The last `days` UTC days ending TODAY (inclusive, today partial), chronological. */
  listDaily(days: number): Promise<BillingSeriesDay[]>;
}
