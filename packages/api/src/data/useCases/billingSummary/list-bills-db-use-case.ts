import {
  BillingPeriodStatus,
  BillingQueryRepository,
} from './billing-summary-protocols.js';
import {
  BillListItem,
  ListBillsUseCase,
} from '../../../core/useCases/list-bills-use-case.js';

export class ListBillsDbUseCase implements ListBillsUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.now = args.now ?? (() => new Date());
  }

  async list(): Promise<BillListItem[]> {
    const rows = await this.billingQueryRepository.listBills();
    const now = this.now();

    return rows.map((row) => {
      const periodStatus: BillingPeriodStatus =
        row.year === now.getUTCFullYear() && row.month === now.getUTCMonth() + 1
          ? 'in_progress'
          : 'open';

      return { ...row, periodStatus };
    });
  }
}
