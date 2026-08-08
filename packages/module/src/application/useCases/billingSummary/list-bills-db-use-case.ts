import {
  BillingPeriodStatus,
  BillingQueryRepository,
} from './billing-summary-protocols.js';
import {
  BillListItem,
  ListBillsUseCase,
} from '@observability/core/domain/useCases/list-bills-use-case.js';
import { BillingPeriodRepository } from '@observability/core/application/interfaces/billing-period-repository.js';
import { BillingSnapshotRepository } from '@observability/core/application/interfaces/billing-snapshot-repository.js';
import {
  BillingPeriodModel,
  closedMonthWindows,
  firstOpenMonthStart,
  monthWindow,
  resolvePeriodStatus,
} from '@observability/core/domain/models/billing-period-model.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';

/**
 * The months list (T7 feed for US6/US7's selector): every OPEN month with
 * any trace in the live scan, PLUS every lifecycle document. Closed months
 * report the SNAPSHOT numbers verbatim (US6: the list shows exactly what
 * the frozen statement shows, forever); open months report the live stamp
 * sums.
 *
 * audit C-7.1: the live scan is bounded to open months
 * (firstOpenMonthStart) — closed history is served from period docs +
 * snapshots, never re-scanned.
 */
export class ListBillsDbUseCase implements ListBillsUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly billingSnapshotRepository: BillingSnapshotRepository;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    billingPeriodRepository: BillingPeriodRepository;
    billingSnapshotRepository: BillingSnapshotRepository;
    now?: () => Date;
    logger?: Logger;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingSnapshotRepository = args.billingSnapshotRepository;
    this.now = args.now ?? (() => new Date());
    this.logger = args.logger ?? nullLogger;
  }

  async list(): Promise<BillListItem[]> {
    // The C-7.1 bound is derived from the DATA, not from the lifecycle
    // documents alone (re-audit iteration 3): a month no lifecycle action
    // ever touched has no period document, so only `earliestTraceAt` — one
    // indexed min read, the same anchor the close-order guard uses — can
    // keep the scan from stepping over its money.
    const [periods, earliestTraceAt] = await Promise.all([
      this.billingPeriodRepository.listAll(),
      this.billingQueryRepository.earliestTraceAt(),
    ]);
    // The closed windows scope the unresolved-quarantine exclusion of the
    // pending numbers to FROZEN months only — the same lens
    // /billing/summary and the close guard apply (re-audit iteration 2).
    const rows = await this.billingQueryRepository.listBills(
      firstOpenMonthStart(periods, earliestTraceAt),
      closedMonthWindows(periods),
    );
    const now = this.now();

    const periodByMonth = new Map(
      periods.map((period) => [`${period.year}-${period.month}`, period]),
    );

    // audit B-1: a future-dated trace (source clock skew, a
    // mis-instrumented agent) must not mint a bill — /billing/summary
    // 400s the month, so listing it here offered the UI a row it could
    // never open (two readers of one truth disagreeing). Excluded and
    // logged: the trace stays archived (invariant 6) and becomes billable
    // when its month arrives.
    const futureRows = rows.filter(
      (row) =>
        resolvePeriodStatus(
          row.year,
          row.month,
          periodByMonth.get(`${row.year}-${row.month}`),
          now,
        ) === 'future',
    );

    for (const row of futureRows) {
      this.logger.warn(
        'Bills: mês tem traces datados no FUTURO — fora da lista de ' +
          'faturas até o mês chegar (anomalia de relógio da fonte? audit B-1)',
        { year: row.year, month: row.month },
      );
    }

    const billableRows = rows.filter((row) => !futureRows.includes(row));

    // audit C-7.3: per-month reads (snapshot + quarantine count) fan out
    // in parallel — the sequential per-month await was an N+1.
    const items = await Promise.all(
      billableRows.map((row) => {
        const period = periodByMonth.get(`${row.year}-${row.month}`);
        periodByMonth.delete(`${row.year}-${row.month}`);

        const periodStatus = resolvePeriodStatus(
          row.year,
          row.month,
          period,
          now,
        );

        return periodStatus === 'closed'
          ? this.closedItem(row.year, row.month, {
              closedAt: period?.closedAt,
              // Live count on purpose: a pending trace can only exist on a
              // closed month if it arrived AFTER the close (quarantined) —
              // the admin must see it, not a frozen zero.
              pendingTraceCount: row.pendingTraceCount,
            })
          : this.openItem(row, periodStatus);
      }),
    );

    // Every period document the live scan did not already answer for:
    // closed months outside the bound (the normal case for all closed
    // history) or with no traces left in the store at all — and, as
    // defence in depth, the NON-closed ones too (re-audit iteration 2: a
    // reopened month used to be filtered out here, so a bound that failed
    // to account for it deleted the month from the list entirely).
    //
    // This pass is a net under DOCUMENTED months only, and cannot be more
    // than that: a month no lifecycle action ever touched has nothing to
    // iterate here (re-audit iteration 3). Its money reaches the list
    // solely because `firstOpenMonthStart` anchors on `earliestTraceAt`
    // and therefore never bounds the scan past a trace-bearing open month.
    const leftovers = await Promise.all(
      [...periodByMonth.values()].map((period) =>
        period.status === 'closed'
          ? this.closedItem(period.year, period.month, {
              closedAt: period.closedAt,
              pendingTraceCount: 0,
            })
          : this.reopenedLeftoverItem(period, now),
      ),
    );

    return [...items, ...leftovers].sort(
      (a, b) => b.year - a.year || b.month - a.month,
    );
  }

  /**
   * A NON-closed period document (i.e. a REOPENED month — documents exist
   * only after a lifecycle action) that the bounded live scan produced no
   * row for. With a correct bound (firstOpenMonthStart accounts for
   * reopened months) that means one thing only: the month has no trace
   * left in the store, so an honest all-zero live bill keeps it in the
   * selector the admin needs to finish the correction.
   *
   * If the store DOES hold traces for it, the bound dropped a month with
   * money — answer loudly, exactly like the missing-snapshot branch: a
   * month must never silently vanish from the list, and it must never be
   * charted as R$ 0,00 while /billing/summary bills it (invariant 3).
   */
  private async reopenedLeftoverItem(
    period: BillingPeriodModel,
    now: Date,
  ): Promise<BillListItem> {
    const { start, end } = monthWindow(period.year, period.month);
    const [hasTraces, quarantinedTraceCount] = await Promise.all([
      this.billingQueryRepository.hasTraces(start, end),
      this.billingQueryRepository.countQuarantined(start, end),
    ]);

    if (hasTraces) {
      throw new Error(
        `Billing period ${period.year}-${period.month} is not closed but ` +
          'fell outside the live scan bound while the store still holds its traces',
      );
    }

    return {
      year: period.year,
      month: period.month,
      periodStatus: resolvePeriodStatus(period.year, period.month, period, now),
      totalCostMicrocents: 0,
      stampedTraceCount: 0,
      pendingTraceCount: 0,
      tokens: 0,
      stampedTokens: 0,
      quarantinedTraceCount,
    };
  }

  private openItem(
    row: {
      year: number;
      month: number;
      totalCostMicrocents: number;
      stampedTraceCount: number;
      pendingTraceCount: number;
      tokens: number;
      stampedTokens: number;
    },
    periodStatus: BillingPeriodStatus,
  ): Promise<BillListItem> {
    const { start, end } = monthWindow(row.year, row.month);

    // audit B-1: no hardcoded zero — a REOPENED month can carry unresolved
    // quarantined traces the admin must see (US5, decision 100).
    return this.billingQueryRepository
      .countQuarantined(start, end)
      .then((quarantinedTraceCount) => ({
        year: row.year,
        month: row.month,
        periodStatus,
        totalCostMicrocents: row.totalCostMicrocents,
        stampedTraceCount: row.stampedTraceCount,
        pendingTraceCount: row.pendingTraceCount,
        tokens: row.tokens,
        stampedTokens: row.stampedTokens,
        quarantinedTraceCount,
      }));
  }

  private async closedItem(
    year: number,
    month: number,
    args: { closedAt?: Date; pendingTraceCount: number },
  ): Promise<BillListItem> {
    const { start, end } = monthWindow(year, month);
    const [snapshot, quarantinedTraceCount] = await Promise.all([
      this.billingSnapshotRepository.findCurrent(year, month),
      this.billingQueryRepository.countQuarantined(start, end),
    ]);

    if (!snapshot) {
      // audit B-10.2: corrupt state answers loudly in EVERY branch — a
      // closed month must never silently vanish from the list.
      throw new Error(
        `Billing period ${year}-${month} is closed but has no snapshot`,
      );
    }

    return {
      year,
      month,
      periodStatus: 'closed',
      totalCostMicrocents: snapshot.statement.totalCostMicrocents,
      stampedTraceCount: snapshot.statement.stampedTraceCount,
      pendingTraceCount: args.pendingTraceCount,
      // audit B-10.4: a frozen bill knows only billed volume — both token
      // figures come verbatim from the snapshot and are equal by
      // construction.
      tokens: snapshot.statement.stampedTokensTotal,
      stampedTokens: snapshot.statement.stampedTokensTotal,
      closedAt: args.closedAt,
      snapshotVersion: snapshot.version,
      quarantinedTraceCount,
    };
  }
}
