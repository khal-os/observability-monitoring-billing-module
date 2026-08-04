import {
  addClientDays,
  clientCalendarOf,
  startOfClientDay,
} from '@observability/core/common/helpers/clock/client-clock.js';
import {
  BillingPeriodRepository,
  BillingQueryRepository,
  BillingSeriesDay,
  BillingSeriesMonth,
  BillingSnapshotRepository,
  CostByTokenType,
  GetBillingSeriesUseCase,
} from './billing-series-protocols.js';
import { TokenType } from '@observability/core/domain/models/price-version-model.js';
import { StatementLine } from '@observability/core/domain/models/billing-snapshot-model.js';
import {
  closedMonthWindows,
  firstOpenMonthStart,
  resolvePeriodStatus,
} from '@observability/core/domain/models/billing-period-model.js';

/** Months on a single integer axis so a continuous range is a simple loop. */
const monthOrdinal = (year: number, month: number): number =>
  year * 12 + (month - 1);

const addTokenCost = (
  split: CostByTokenType,
  tokenType: TokenType,
  costMicrocents: number,
): void => {
  const entry = split.find((candidate) => candidate.tokenType === tokenType);

  if (entry) {
    entry.costMicrocents += costMicrocents;
  } else {
    split.push({ tokenType, costMicrocents });
  }
};

/** Frozen-number sums only — never a recomputation (T7). */
const splitOfLines = (lines: StatementLine[]): CostByTokenType => {
  const split: CostByTokenType = [];

  for (const line of lines) {
    addTokenCost(split, line.tokenType, line.costMicrocents);
  }

  return split;
};

/**
 * T8: ONE total per month, everywhere. Closed months come verbatim from
 * their snapshot (so the series always matches each frozen statement —
 * US11 "valores fechando com cada extrato"); open months are live sums of
 * the same stamps. History starts shallow (≈49-day backfill) and fattens
 * as months accumulate — the series just reflects what the store has.
 */
export class GetBillingSeriesDbUseCase implements GetBillingSeriesUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly billingSnapshotRepository: BillingSnapshotRepository;
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    billingPeriodRepository: BillingPeriodRepository;
    billingSnapshotRepository: BillingSnapshotRepository;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingSnapshotRepository = args.billingSnapshotRepository;
    this.now = args.now ?? (() => new Date());
  }

  async list(maxMonths: number): Promise<BillingSeriesMonth[]> {
    // Periods first: closed months are served from snapshots below, so the
    // rollup only needs to scan open months (C-7.1 bound — same rule as
    // list-bills, including the data anchor: a never-closed month owns no
    // period document, and its bar must not be missing from the chart).
    const [periods, earliestTraceAt] = await Promise.all([
      this.billingPeriodRepository.listAll(),
      this.billingQueryRepository.earliestTraceAt(),
    ]);
    const rollup = await this.billingQueryRepository.monthlyRollup(
      firstOpenMonthStart(periods, earliestTraceAt),
    );
    const now = this.now();
    // Decision 130: "the current month" is the client's.
    const nowCalendar = clientCalendarOf(now);
    const currentOrdinal = monthOrdinal(nowCalendar.year, nowCalendar.month);

    const periodByOrdinal = new Map(
      periods.map((period) => [
        monthOrdinal(period.year, period.month),
        period,
      ]),
    );
    const rollupByMonth = new Map(
      rollup.map((row) => [monthOrdinal(row.year, row.month), row]),
    );

    // Continuous range from the oldest data/period month through the
    // current month: a month with zero traffic materializes as a zero bar
    // — a gap in traffic must LOOK like a gap (the daily lens's rule,
    // applied to the monthly axis). An empty store charts nothing.
    // audit B-1: the axis never runs past the CURRENT month. One trace
    // dated 2027 used to drag lastOrdinal a year out — slice(-12) then
    // kept twelve zero-filled FUTURE bars and pushed every real month
    // (including the current one) off the chart, all at R$ 0,00 with
    // nothing signalling the anomaly. Future-dated data stays archived
    // and charts when its month arrives.
    const knownOrdinals = [
      ...rollupByMonth.keys(),
      ...periodByOrdinal.keys(),
    ].filter((ordinal) => ordinal <= currentOrdinal);

    if (knownOrdinals.length === 0) return [];

    const firstOrdinal = Math.min(...knownOrdinals);
    const lastOrdinal = Math.max(...knownOrdinals, currentOrdinal);

    const ordinals: number[] = [];
    for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += 1) {
      ordinals.push(ordinal);
    }

    // The cap applies BEFORE any snapshot lookup — months outside the
    // window must never cost a per-month snapshot query.
    const window = ordinals.slice(-maxMonths);

    const months: BillingSeriesMonth[] = [];

    for (const ordinal of window) {
      const year = Math.floor(ordinal / 12);
      const month = (ordinal % 12) + 1;

      const periodStatus = resolvePeriodStatus(
        year,
        month,
        periodByOrdinal.get(ordinal),
        now,
      );

      if (periodStatus === 'closed') {
        months.push(await this.fromSnapshot(year, month));
        continue;
      }

      const row = rollupByMonth.get(ordinal);

      months.push({
        year,
        month,
        periodStatus,
        totalCostMicrocents: row?.totalCostMicrocents ?? 0,
        byTokenType: row?.byTokenType ?? [],
        byAgent: row?.byAgent ?? [],
        byModel: row?.byModel ?? [],
      });
    }

    return months;
  }

  private async fromSnapshot(
    year: number,
    month: number,
  ): Promise<BillingSeriesMonth> {
    const snapshot = await this.billingSnapshotRepository.findCurrent(
      year,
      month,
    );

    if (!snapshot) {
      throw new Error(
        `Billing period ${year}-${month} is closed but has no snapshot`,
      );
    }

    // Snapshot agents group by (id, version) — the series' agent dimension
    // is the id alone, so versions of one agent merge here. Sums of frozen
    // numbers, no recomputation (T7).
    const byAgent = new Map<
      string | null,
      { costMicrocents: number; byTokenType: CostByTokenType }
    >();
    for (const group of snapshot.statement.agents) {
      let entry = byAgent.get(group.agentId);

      if (!entry) {
        entry = { costMicrocents: 0, byTokenType: [] };
        byAgent.set(group.agentId, entry);
      }

      entry.costMicrocents += group.costMicrocents;
      for (const [tokenType, costMicrocents] of Object.entries(
        group.costByTokenTypeMicrocents,
      )) {
        addTokenCost(entry.byTokenType, tokenType as TokenType, costMicrocents);
      }
    }

    const modelSplit = new Map<string | null, CostByTokenType>();
    for (const line of snapshot.statement.lines) {
      const split = modelSplit.get(line.model) ?? [];
      addTokenCost(split, line.tokenType, line.costMicrocents);
      modelSplit.set(line.model, split);
    }

    return {
      year,
      month,
      periodStatus: 'closed',
      totalCostMicrocents: snapshot.statement.totalCostMicrocents,
      byTokenType: splitOfLines(snapshot.statement.lines),
      byAgent: [...byAgent.entries()]
        .map(([agentId, entry]) => ({ agentId, ...entry }))
        .sort((a, b) => b.costMicrocents - a.costMicrocents),
      byModel: snapshot.statement.modelMixTotal.map((share) => ({
        model: share.model,
        costMicrocents: share.costMicrocents,
        byTokenType: modelSplit.get(share.model) ?? [],
      })),
    };
  }

  /**
   * The daily lens (decision 97): same stamps, CLIENT-day buckets
   * (decision 130), today included and partial. Served from the live store; unresolved
   * quarantine is excluded ONLY on days inside CLOSED months — those days
   * must sum to the frozen bill, while a reopened month's straggler is in
   * the LIVE total and must chart (re-audit fix: Σ daily ≡ summary holds
   * throughout a reopen→re-close window). Empty days materialize as zero
   * bars (a gap in traffic must LOOK like a gap).
   */
  async listDaily(days: number): Promise<BillingSeriesDay[]> {
    const now = this.now();
    // Decision 130: the ladder walks CLIENT midnights — the same instants
    // the rollup's $dateTrunc buckets sit on. addClientDays steps in
    // wall-clock space so a DST 23h/25h day never drifts it.
    const todayStart = startOfClientDay(now);
    const from = addClientDays(todayStart, -(days - 1));
    const toExclusive = addClientDays(todayStart, 1);

    // Periods FIRST: the rollup's quarantine-exclusion scope is exactly
    // the closed months' windows.
    const periods = await this.billingPeriodRepository.listAll();
    const rollup = await this.billingQueryRepository.dailyRollup(
      from,
      toExclusive,
      closedMonthWindows(periods),
    );

    const periodByMonth = new Map(
      periods.map((period) => [`${period.year}-${period.month}`, period]),
    );
    const byTime = new Map(rollup.map((row) => [row.date.getTime(), row]));

    const result: BillingSeriesDay[] = [];

    for (
      let date = from;
      date.getTime() < toExclusive.getTime();
      date = addClientDays(date, 1)
    ) {
      const row = byTime.get(date.getTime());
      // Decision 130: which month a day belongs to is the CLIENT calendar.
      const calendar = clientCalendarOf(date);
      const monthKey = `${calendar.year}-${calendar.month}`;

      // The day's status is its MONTH's status — same domain rule, daily lens.
      const periodStatus = resolvePeriodStatus(
        calendar.year,
        calendar.month,
        periodByMonth.get(monthKey),
        now,
      );

      result.push({
        date,
        periodStatus,
        partial: date.getTime() === todayStart.getTime(),
        totalCostMicrocents: row?.totalCostMicrocents ?? 0,
        byTokenType: row?.byTokenType ?? [],
      });
    }

    return result;
  }
}
