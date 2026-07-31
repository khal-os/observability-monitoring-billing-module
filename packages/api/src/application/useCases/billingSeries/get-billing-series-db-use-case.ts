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
    const [rollup, periods] = await Promise.all([
      this.billingQueryRepository.monthlyRollup(),
      this.billingPeriodRepository.listAll(),
    ]);
    const now = this.now();

    const closedMonths = new Set(
      periods
        .filter((period) => period.status === 'closed')
        .map((period) => `${period.year}-${period.month}`),
    );

    const months: BillingSeriesMonth[] = [];

    for (const row of rollup) {
      const key = `${row.year}-${row.month}`;

      if (closedMonths.has(key)) {
        closedMonths.delete(key);
        months.push(await this.fromSnapshot(row.year, row.month));
        continue;
      }

      const isCurrent =
        row.year === now.getUTCFullYear() && row.month === now.getUTCMonth() + 1;

      months.push({
        year: row.year,
        month: row.month,
        periodStatus: isCurrent ? 'in_progress' : 'open',
        totalCostMicrocents: row.totalCostMicrocents,
        byTokenType: row.byTokenType,
        byAgent: row.byAgent,
        byModel: row.byModel,
      });
    }

    // Closed months with no traces left in the store still chart.
    for (const key of closedMonths) {
      const [year, month] = key.split('-').map(Number);
      months.push(await this.fromSnapshot(year as number, month as number));
    }

    return months
      .sort((a, b) => a.year - b.year || a.month - b.month)
      .slice(-maxMonths);
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
   * included and partial. Served from the live store with quarantined
   * traces excluded — the days of a closed month therefore sum to its
   * frozen bill. Empty days materialize as zero bars (a gap in traffic
   * must LOOK like a gap).
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

    const [rollup, periods] = await Promise.all([
      this.billingQueryRepository.dailyRollup(from, toExclusive),
      this.billingPeriodRepository.listAll(),
    ]);

    const closedMonths = new Set(
      periods
        .filter((period) => period.status === 'closed')
        .map((period) => `${period.year}-${period.month}`),
    );
    const byTime = new Map(rollup.map((row) => [row.date.getTime(), row]));

    const result: BillingSeriesDay[] = [];

    for (let time = from.getTime(); time < toExclusive.getTime(); time += 86_400_000) {
      const date = new Date(time);
      const row = byTime.get(time);
      const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;

      const periodStatus = closedMonths.has(monthKey)
        ? 'closed'
        : date.getUTCFullYear() === now.getUTCFullYear() &&
            date.getUTCMonth() === now.getUTCMonth()
          ? 'in_progress'
          : 'open';

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
