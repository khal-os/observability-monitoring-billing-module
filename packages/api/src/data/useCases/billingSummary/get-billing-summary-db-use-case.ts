import {
  BillingPeriodStatus,
  BillingQueryRepository,
  BillingSummary,
  GetBillingSummaryUseCase,
} from './billing-summary-protocols.js';
import { sumMicrocents } from '../../../common/helpers/money/money.js';

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

export class GetBillingSummaryDbUseCase implements GetBillingSummaryUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.now = args.now ?? (() => new Date());
  }

  async get(year: number, month: number): Promise<BillingSummary> {
    const { start, end } = monthWindowUtc(year, month);

    const aggregate = await this.billingQueryRepository.aggregateMonth(
      start,
      end,
    );

    // Invariant 3: the total IS the sum of the stamped lines — there is no
    // second calculation path to diverge from.
    const totalCostMicrocents = sumMicrocents(
      aggregate.lines.map((line) => line.costMicrocents),
    );

    const now = this.now();
    const periodStatus: BillingPeriodStatus =
      year === now.getUTCFullYear() && month === now.getUTCMonth() + 1
        ? 'in_progress'
        : 'open';

    return {
      year,
      month,
      periodStatus,
      totalCostMicrocents,
      lines: aggregate.lines,
      pendingPrice: aggregate.pendingPrice,
    };
  }
}
