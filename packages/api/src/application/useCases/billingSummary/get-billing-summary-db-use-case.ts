import {
  BillingMonthComparison,
  BillingPeriodStatus,
  BillingQueryRepository,
  BillingReopenNote,
  BillingSummary,
  GetBillingSummaryUseCase,
} from './billing-summary-protocols.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { BillingSnapshotRepository } from '../../interfaces/billing-snapshot-repository.js';
import { BillingPeriodModel } from '../../../domain/models/billing-period-model.js';
import { StatementProjection } from '../../../domain/models/billing-snapshot-model.js';
import { buildStatement } from '../billingStatement/statement-engine.js';

export const monthWindowUtc = (
  year: number,
  month: number,
): { start: Date; end: Date } => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid billing period: year=${year}, month=${month}`);
  }

  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
};

export const previousMonthOf = (
  year: number,
  month: number,
): { year: number; month: number } =>
  month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

/**
 * T7: the statement read layer. A CLOSED month is served exclusively from
 * its snapshot — statement numbers verbatim, never recomputed (US6: they
 * match the snapshot forever). An open month runs the SAME engine live
 * over the same stamps. The month-over-month comparison (US10) is derived
 * at read time from both months' totals — informative only.
 */
export class GetBillingSummaryDbUseCase implements GetBillingSummaryUseCase {
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

  async get(year: number, month: number): Promise<BillingSummary> {
    const { start, end } = monthWindowUtc(year, month);

    const period = await this.billingPeriodRepository.find(year, month);
    const periodStatus = this.periodStatus(year, month, period);

    const monthData = await this.monthStatement(year, month, periodStatus);

    const pendingPrice = await this.billingQueryRepository.pendingPriceSummary(
      start,
      end,
    );
    const quarantinedTraceCount =
      await this.billingQueryRepository.countQuarantined(start, end);

    const comparison = await this.comparison(year, month, monthData.statement);

    const reopenNotes: BillingReopenNote[] = (period?.audit ?? [])
      .filter((entry) => entry.action === 'reopen')
      .map((entry) => ({ at: entry.at, reason: entry.reason ?? '' }));

    return {
      year,
      month,
      periodStatus,
      statement: monthData.statement,
      pendingPrice,
      ingestionWatermark: monthData.ingestionWatermark,
      ...(periodStatus === 'closed'
        ? {
            closedAt: period?.closedAt,
            snapshotVersion: period?.snapshotVersion,
            snapshotVersions: monthData.snapshotVersions,
          }
        : {}),
      reopenNotes,
      quarantinedTraceCount,
      comparison,
    };
  }

  private periodStatus(
    year: number,
    month: number,
    period: BillingPeriodModel | null,
  ): BillingPeriodStatus {
    if (period?.status === 'closed') return 'closed';

    const now = this.now();

    return year === now.getUTCFullYear() && month === now.getUTCMonth() + 1
      ? 'in_progress'
      : 'open';
  }

  private async monthStatement(
    year: number,
    month: number,
    periodStatus: BillingPeriodStatus,
  ): Promise<{
    statement: StatementProjection;
    ingestionWatermark: Date | null;
    snapshotVersions?: { version: number; createdAt: Date }[];
  }> {
    if (periodStatus === 'closed') {
      const snapshot = await this.billingSnapshotRepository.findCurrent(
        year,
        month,
      );

      if (!snapshot) {
        // A closed period without its snapshot is corrupt state, not a
        // case to paper over with a live recomputation (T7).
        throw new Error(
          `Billing period ${year}-${month} is closed but has no snapshot`,
        );
      }

      return {
        statement: snapshot.statement,
        ingestionWatermark: snapshot.ingestionWatermark,
        snapshotVersions: await this.listVersions(year, month, snapshot.version),
      };
    }

    const { start, end } = monthWindowUtc(year, month);
    const records = await this.billingQueryRepository.fetchUsageRecords(
      start,
      end,
    );

    return {
      statement: buildStatement(records),
      ingestionWatermark: await this.billingQueryRepository.ingestionWatermark(
        start,
        end,
      ),
    };
  }

  private async listVersions(
    year: number,
    month: number,
    currentVersion: number,
  ): Promise<{ version: number; createdAt: Date }[]> {
    const versions: { version: number; createdAt: Date }[] = [];

    for (let version = 1; version <= currentVersion; version += 1) {
      const snapshot = await this.billingSnapshotRepository.findVersion(
        year,
        month,
        version,
      );

      if (snapshot) {
        versions.push({ version, createdAt: snapshot.createdAt });
      }
    }

    return versions;
  }

  /**
   * US10: previous month totals per agent — from ITS snapshot when closed,
   * live otherwise. Null when neither month has any stamped trace.
   */
  private async comparison(
    year: number,
    month: number,
    current: StatementProjection,
  ): Promise<BillingMonthComparison | null> {
    const previous = previousMonthOf(year, month);

    const previousPeriod = await this.billingPeriodRepository.find(
      previous.year,
      previous.month,
    );
    const previousStatus = this.periodStatus(
      previous.year,
      previous.month,
      previousPeriod,
    );

    const previousData = await this.monthStatement(
      previous.year,
      previous.month,
      previousStatus,
    );
    const previousStatement = previousData.statement;

    if (
      previousStatement.stampedTraceCount === 0 &&
      current.stampedTraceCount === 0
    ) {
      return null;
    }

    const agentKeys = new Map<
      string,
      { agentId: string | null; agentVersion: string | null }
    >();

    for (const group of [...current.agents, ...previousStatement.agents]) {
      agentKeys.set(`${group.agentId ?? ' '}@@${group.agentVersion ?? ' '}`, {
        agentId: group.agentId,
        agentVersion: group.agentVersion,
      });
    }

    const findCost = (
      statement: StatementProjection,
      agentId: string | null,
      agentVersion: string | null,
    ): number =>
      statement.agents.find(
        (group) =>
          group.agentId === agentId && group.agentVersion === agentVersion,
      )?.costMicrocents ?? 0;

    return {
      previousYear: previous.year,
      previousMonth: previous.month,
      previousPeriodStatus: previousStatus,
      previousTotalCostMicrocents: previousStatement.totalCostMicrocents,
      totalDeltaMicrocents:
        current.totalCostMicrocents - previousStatement.totalCostMicrocents,
      byAgent: [...agentKeys.values()]
        .map(({ agentId, agentVersion }) => {
          const currentCost = findCost(current, agentId, agentVersion);
          const previousCost = findCost(
            previousStatement,
            agentId,
            agentVersion,
          );

          return {
            agentId,
            agentVersion,
            currentCostMicrocents: currentCost,
            previousCostMicrocents: previousCost,
            deltaMicrocents: currentCost - previousCost,
          };
        })
        .sort((a, b) => b.currentCostMicrocents - a.currentCostMicrocents),
    };
  }
}
