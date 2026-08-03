import {
  BillingPeriodRepository,
  BillingQueryRepository,
  BillingSeriesDay,
  BillingSeriesMonth,
  BillingSnapshotRepository,
  CostByTokenType,
  GetBillingSeriesUseCase,
} from './billing-series-protocols.js';
import { TokenType } from '../../../domain/models/price-version-model.js';
import { StatementLine } from '../../../domain/models/billing-snapshot-model.js';
import {
  closedMonthWindows,
  firstOpenMonthStart,
  resolvePeriodStatus,
} from '../../../domain/models/billing-period-model.js';

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
    // list-bills).
    const periods = await this.billingPeriodRepository.listAll();
    const rollup = await this.billingQueryRepository.monthlyRollup(
      firstOpenMonthStart(periods),
    );
    const now = this.now();
    const currentOrdinal = monthOrdinal(
      now.getUTCFullYear(),
      now.getUTCMonth() + 1,
    );

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
    const knownOrdinals = [...rollupByMonth.keys(), ...periodByOrdinal.keys()];

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
   * The daily lens (decision 97): same stamps, UTC-day buckets, today
   * included and partial. Served from the live store; unresolved
   * quarantine is excluded ONLY on days inside CLOSED months — those days
   * must sum to the frozen bill, while a reopened month's straggler is in
   * the LIVE total and must chart (re-audit fix: Σ daily ≡ summary holds
   * throughout a reopen→re-close window). Empty days materialize as zero
   * bars (a gap in traffic must LOOK like a gap).
   */
  async listDaily(days: number): Promise<BillingSeriesDay[]> {
    const now = this.now();
    const todayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const from = new Date(todayStart - (days - 1) * 86_400_000);
    const toExclusive = new Date(todayStart + 86_400_000);

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

    for (let time = from.getTime(); time < toExclusive.getTime(); time += 86_400_000) {
      const date = new Date(time);
      const row = byTime.get(time);
      const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;

      // The day's status is its MONTH's status — same domain rule, daily lens.
      const periodStatus = resolvePeriodStatus(
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        periodByMonth.get(monthKey),
        now,
      );

      result.push({
        date,
        periodStatus,
        partial: time === todayStart,
        totalCostMicrocents: row?.totalCostMicrocents ?? 0,
        byTokenType: row?.byTokenType ?? [],
      });
    }

    return result;
  }
}
