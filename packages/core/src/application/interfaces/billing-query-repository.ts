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
   * Pending traces with UNRESOLVED quarantine excluded ONLY inside CLOSED
   * months (decision 100, scoped by re-audit iteration 2): in a frozen
   * month the straggler is outside the bill and countQuarantined carries
   * it; in an open or REOPENED month the live statement bills that month,
   * so its pending traces count here. Same lens as `pendingPriceSummary`
   * and the close guard — that is what keeps /bills, /billing/summary and
   * `make billing-close` from ever disagreeing about one month.
   */
  pendingTraceCount: number;
  /**
   * audit B-10.4: stamped + pending tokens (the live "month volume so
   * far" meaning). Excludes only tokens of pending traces excluded from
   * `pendingTraceCount` above, by the very same lens.
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
   * `excludeUnresolvedQuarantine` is the CLOSED-month lens, and the caller
   * MUST state it — same scoping decision 113 gave `dailyRollup`, applied
   * to the pending question (re-audit iteration 2):
   * - inside a FROZEN month a pending straggler is outside the bill by
   *   construction (decision 100) — countQuarantined carries it;
   * - anywhere else (never-closed, in-progress and above all REOPENED
   *   months) the live statement bills every stamped trace of the month,
   *   so a pending one is an OPEN cost of that same live bill: it counts,
   *   it blocks the close, and pricing it is exactly decision 89's
   *   correction flow. Exempting it there froze a bill that silently
   *   omitted its cost while reporting zero pending.
   */
  pendingPriceSummary(
    monthStart: Date,
    monthEnd: Date,
    opts: { excludeUnresolvedQuarantine: boolean },
  ): Promise<PendingPriceSummary>;

  /**
   * One bill per UTC calendar month that has at least one trace IN THE
   * SCAN WINDOW, most recent first. Totals are sums of the SAME
   * ingestion-time stamps the statement reads (one store, one truth).
   *
   * audit C-7.1: `sinceInclusive` bounds the scan to open months
   * (startedAt >= bound) — closed months are served from their period
   * docs + snapshots by the caller, never from this live scan. Null =
   * unbounded (no month ever closed).
   *
   * `closedMonthWindows` scopes the unresolved-quarantine exclusion of
   * `pendingTraceCount`/`tokens` to frozen months, exactly as it does for
   * `dailyRollup` (decision 113) and as the required lens does for
   * `pendingPriceSummary` (re-audit iteration 2). The caller MUST state
   * it: a REOPENED month inside the scan whose stragglers were exempted
   * here reported `0 pending` on /bills while /billing/summary counted
   * them and `make billing-close` refused on them.
   */
  listBills(
    sinceInclusive: Date | null | undefined,
    closedMonthWindows: { start: Date; end: Date }[],
  ): Promise<BillRow[]>;

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

  /**
   * Traces whose LLM reported no measured usage (decision 128) inside the
   * month window — a live CONTEXT count on the summary, exactly like
   * countQuarantined: never a statement input, so it exists for closed
   * months too without touching the frozen snapshot or the
   * STATEMENT_LOGIC_VERSION.
   */
  countNoMeasuredUsage(monthStart: Date, monthEnd: Date): Promise<number>;

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
