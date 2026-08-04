import {
  BillingMonthComparison,
  BillingPeriodStatus,
  BillingQueryRepository,
  BillingReopenNote,
  BillingSummary,
  GetBillingSummaryUseCase,
} from './billing-summary-protocols.js';
import { BillingPeriodRepository } from '@observability/core/application/interfaces/billing-period-repository.js';
import { BillingSnapshotRepository } from '@observability/core/application/interfaces/billing-snapshot-repository.js';
import {
  BillingPeriodModel,
  monthWindowUtc,
  previousMonthOf,
  resolvePeriodStatus,
} from '@observability/core/domain/models/billing-period-model.js';
import { StatementProjection } from '@observability/core/domain/models/billing-snapshot-model.js';
import { BillingPeriodStateError } from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import {
  agentKey,
  buildStatement,
} from '../billingStatement/statement-engine.js';

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

    // audit B-10.3 + B-1: nothing legitimate queries the future — a future
    // month used to render (and export!) a legit-looking zero bill labeled
    // "aguardando fechamento". The check DERIVES from resolvePeriodStatus
    // (its one home) instead of re-spelling the comparison: this guard
    // once existed only here while /bills and the series had their own
    // ideas, and three readers of one truth drifted. The controllers map
    // this error to a 400.
    const period = await this.billingPeriodRepository.find(year, month);
    const periodStatus = this.periodStatus(year, month, period);

    if (periodStatus === 'future') {
      throw new BillingPeriodStateError(
        `O mês ${year}-${String(month).padStart(2, '0')} está no futuro — ` +
          'não há nada a faturar.',
      );
    }

    const monthData = await this.monthStatement(year, month, periodStatus);

    // Re-audit: the unresolved-quarantine exemption is the CLOSED-month
    // lens only. A closed month's straggler is outside the frozen bill
    // (decision 100) and is reported by quarantinedTraceCount; a reopened
    // month is billed LIVE, so its pending straggler is an open cost of
    // the statement above and must show — the same number the close guard
    // will block on.
    const pendingPrice = await this.billingQueryRepository.pendingPriceSummary(
      start,
      end,
      { excludeUnresolvedQuarantine: periodStatus === 'closed' },
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
    return resolvePeriodStatus(year, month, period, this.now());
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
        // audit C-7.3: one indexed read for all versions — the previous
        // findVersion(1..n) probe was n sequential round trips.
        snapshotVersions: await this.billingSnapshotRepository.listVersions(
          year,
          month,
        ),
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

    // The engine's OWN key (decision 122's sentinel), imported rather than
    // spelled again here: this loop used to join on a space, which collides
    // an unattributed trace with a whitespace-named agent and dropped a
    // whole row from the comparison panel (re-audit iteration 6).
    for (const group of [...current.agents, ...previousStatement.agents]) {
      agentKeys.set(agentKey(group.agentId, group.agentVersion), {
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
