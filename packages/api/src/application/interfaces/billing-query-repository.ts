import { PendingPriceSummary } from '../../domain/useCases/get-billing-summary-use-case.js';
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
  /**
   * Pending traces with UNRESOLVED quarantine excluded (decision 100):
   * a quarantined pending trace is outside the bill's scope and is
   * surfaced via the quarantine count, not here — same rule as
   * pendingPriceSummary, so the two endpoints can never disagree.
   */
  pendingTraceCount: number;
  /**
   * audit B-10.4: stamped + pending tokens (the live "month volume so
   * far" meaning). Excludes only tokens of pending traces with unresolved
   * quarantine (outside the bill's scope, decision 100).
   */
  tokens: number;
  /** audit B-10.4: tokens of STAMPED traces only — the billed volume. */
  stampedTokens: number;
}

export interface BillingQueryRepository {
  /**
   * Pending-price rollup of the month window [monthStart, monthEnd) —
   * counted APART from the total, never inside it (invariant 2).
   *
   * EXCLUDES pending traces with UNRESOLVED quarantine (decision 100):
   * a quarantined trace is outside the close's scope, so it must not
   * block the close's pending guard — it is surfaced by countQuarantined
   * instead, and only the audited reopen flow brings it back into play.
   */
  pendingPriceSummary(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<PendingPriceSummary>;

  /**
   * One bill per UTC calendar month that has at least one trace IN THE
   * SCAN WINDOW, most recent first. Totals are sums of the SAME
   * ingestion-time stamps the statement reads (one store, one truth).
   *
   * audit C-7.1: `sinceInclusive` bounds the scan to open months
   * (startedAt >= bound) — closed months are served from their period
   * docs + snapshots by the caller, never from this live scan. Omitted or
   * null = unbounded (no month ever closed).
   */
  listBills(sinceInclusive?: Date | null): Promise<BillRow[]>;

  /**
   * The statement engine's diet for one month: one record per STAMPED
   * trace of [monthStart, monthEnd), stamps copied verbatim, payloads and
   * spans never loaded (decision 47). Deterministic order (traceId) —
   * determinism is the reproducibility contract's requirement; the sort
   * happens in process, after materialization (audit C-7.2: a DB-side
   * sort had no serving index and aborted past the 100MB sort ceiling,
   * taking the close down with it).
   */
  fetchUsageRecords(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BillingUsageRecord[]>;

  /**
   * Monthly cost rollup (T8 live side): totals plus per-agent and
   * per-model sums of the same stamps, each with its token-type split.
   *
   * audit C-7.1: `sinceInclusive` bounds the scan to open months — the
   * caller serves closed months from snapshots. Omitted or null =
   * unbounded.
   */
  monthlyRollup(sinceInclusive?: Date | null): Promise<MonthlyRollupRow[]>;

  /**
   * Daily cost rollup over [from, toExclusive), UTC-day buckets, token-type
   * split. EXCLUDES traces with UNRESOLVED quarantine (reason present,
   * absorbedInSnapshotVersion absent — decision 100) ONLY on days inside
   * `closedMonthWindows`: the days of a CLOSED month must sum to its
   * frozen bill (decision 97), and a trace absorbed by a re-close
   * (decision 89) is billed, so it charts. Outside those windows (open,
   * in-progress, or REOPENED months) the live summary bills every stamped
   * trace — straggler included — so no exclusion applies there, keeping
   * Σ daily ≡ live summary throughout a reopen→re-close window.
   */
  dailyRollup(
    from: Date,
    toExclusive: Date,
    closedMonthWindows: { start: Date; end: Date }[],
  ): Promise<DailyRollupRow[]>;

  /** Max ingestedAt among the month's traces (freshness watermark), or null. */
  ingestionWatermark(monthStart: Date, monthEnd: Date): Promise<Date | null>;

  /**
   * Traces of the month whose quarantine is UNRESOLVED (flagged and not
   * absorbed by any snapshot — decision 100): the admin-visible "outside
   * the bill" count (US5). A trace billed by a re-close (absorbed) no
   * longer counts here.
   */
  countQuarantined(monthStart: Date, monthEnd: Date): Promise<number>;

  /** Total stamped cost accrued in [monthStart, upTo) — the projection's numerator (US12). */
  accruedCostMicrocents(monthStart: Date, upTo: Date): Promise<number>;

  /**
   * startedAt of the EARLIEST stored trace (one indexed min read), or null
   * on an empty store. The close-order guard's anchor (re-audit): every
   * month from here to the month being closed must be closed or
   * trace-free before a newer month may close.
   */
  earliestTraceAt(): Promise<Date | null>;

  /**
   * Cheap existence probe: does ANY trace start inside
   * [monthStart, monthEnd)? Used by the close-order guard to let genuine
   * gap months (no traffic at all) pass without a lifecycle document.
   */
  hasTraces(monthStart: Date, monthEnd: Date): Promise<boolean>;
}
