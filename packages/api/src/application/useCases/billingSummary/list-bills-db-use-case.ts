import {
  BillingPeriodStatus,
  BillingQueryRepository,
} from './billing-summary-protocols.js';
import {
  BillListItem,
  ListBillsUseCase,
} from '../../../domain/useCases/list-bills-use-case.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { BillingSnapshotRepository } from '../../interfaces/billing-snapshot-repository.js';
import { firstOpenMonthStart, monthWindowUtc } from './get-billing-summary-db-use-case.js';

/**
 * The months list (T7 feed for US6/US7's selector): every OPEN month with
 * any trace in the live scan, PLUS every closed month's lifecycle
 * document. Closed months report the SNAPSHOT numbers verbatim (US6: the
 * list shows exactly what the frozen statement shows, forever); open
 * months report the live stamp sums.
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

  async list(): Promise<BillListItem[]> {
    const periods = await this.billingPeriodRepository.listAll();
    const rows = await this.billingQueryRepository.listBills(
      firstOpenMonthStart(periods),
    );
    const now = this.now();

    const periodByMonth = new Map(
      periods.map((period) => [`${period.year}-${period.month}`, period]),
    );

    // audit C-7.3: per-month reads (snapshot + quarantine count) fan out
    // in parallel — the sequential per-month await was an N+1.
    const items = await Promise.all(
      rows.map((row) => {
        const period = periodByMonth.get(`${row.year}-${row.month}`);
        periodByMonth.delete(`${row.year}-${row.month}`);

        let periodStatus: BillingPeriodStatus;
        if (period?.status === 'closed') {
          periodStatus = 'closed';
        } else if (
          row.year === now.getUTCFullYear() &&
          row.month === now.getUTCMonth() + 1
        ) {
          periodStatus = 'in_progress';
        } else {
          periodStatus = 'open';
        }

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

    // Closed months outside the live scan bound (the normal case for all
    // closed history) or with no traces left in the store at all.
    const closedLeftovers = await Promise.all(
      [...periodByMonth.values()]
        .filter((period) => period.status === 'closed')
        .map((period) =>
          this.closedItem(period.year, period.month, {
            closedAt: period.closedAt,
            pendingTraceCount: 0,
          }),
        ),
    );

    return [...items, ...closedLeftovers].sort(
      (a, b) => b.year - a.year || b.month - a.month,
    );
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
    const { start, end } = monthWindowUtc(row.year, row.month);

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
    const { start, end } = monthWindowUtc(year, month);
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
