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
import { monthWindowUtc } from './get-billing-summary-db-use-case.js';

/**
 * The months list (T7 feed for US6/US7's selector): every month with any
 * trace, PLUS every closed month whose lifecycle document exists without
 * traces in the store. Closed months report the SNAPSHOT numbers verbatim
 * (US6: the list shows exactly what the frozen statement shows, forever);
 * open months report the live stamp sums.
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
    const [rows, periods] = await Promise.all([
      this.billingQueryRepository.listBills(),
      this.billingPeriodRepository.listAll(),
    ]);
    const now = this.now();

    const periodByMonth = new Map(
      periods.map((period) => [`${period.year}-${period.month}`, period]),
    );

    const items: BillListItem[] = [];

    for (const row of rows) {
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

      if (periodStatus === 'closed') {
        const snapshot = await this.billingSnapshotRepository.findCurrent(
          row.year,
          row.month,
        );

        if (!snapshot) {
          throw new Error(
            `Billing period ${row.year}-${row.month} is closed but has no snapshot`,
          );
        }

        const { start, end } = monthWindowUtc(row.year, row.month);

        items.push({
          year: row.year,
          month: row.month,
          periodStatus,
          totalCostMicrocents: snapshot.statement.totalCostMicrocents,
          stampedTraceCount: snapshot.statement.stampedTraceCount,
          // Live count on purpose: a pending trace can only exist on a
          // closed month if it arrived AFTER the close (quarantined) —
          // the admin must see it, not a frozen zero.
          pendingTraceCount: row.pendingTraceCount,
          tokens: snapshot.statement.stampedTokensTotal,
          closedAt: period?.closedAt,
          snapshotVersion: snapshot.version,
          quarantinedTraceCount:
            await this.billingQueryRepository.countQuarantined(start, end),
        });
      } else {
        items.push({
          year: row.year,
          month: row.month,
          periodStatus,
          totalCostMicrocents: row.totalCostMicrocents,
          stampedTraceCount: row.stampedTraceCount,
          pendingTraceCount: row.pendingTraceCount,
          tokens: row.tokens,
          quarantinedTraceCount: 0,
        });
      }
    }

    // Closed months whose traces are absent from the store entirely.
    for (const period of periodByMonth.values()) {
      if (period.status !== 'closed') continue;

      const snapshot = await this.billingSnapshotRepository.findCurrent(
        period.year,
        period.month,
      );

      if (!snapshot) continue;

      items.push({
        year: period.year,
        month: period.month,
        periodStatus: 'closed',
        totalCostMicrocents: snapshot.statement.totalCostMicrocents,
        stampedTraceCount: snapshot.statement.stampedTraceCount,
        pendingTraceCount: 0,
        tokens: snapshot.statement.stampedTokensTotal,
        closedAt: period.closedAt,
        snapshotVersion: snapshot.version,
        quarantinedTraceCount: 0,
      });
    }

    return items.sort((a, b) => b.year - a.year || b.month - a.month);
  }
}
