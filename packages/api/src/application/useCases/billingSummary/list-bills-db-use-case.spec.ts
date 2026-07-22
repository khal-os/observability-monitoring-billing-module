import {
  BillingMonthAggregate,
  BillRow,
  BillingQueryRepository,
} from './billing-summary-protocols.js';
import { ListBillsDbUseCase } from './list-bills-db-use-case.js';

const makeRows = (): BillRow[] => [
  {
    year: 2026,
    month: 7,
    totalCostMicrocents: 8_000_000,
    stampedTraceCount: 13,
    pendingTraceCount: 1,
    tokens: 21_038,
  },
  {
    year: 2026,
    month: 6,
    totalCostMicrocents: 8_220_000,
    stampedTraceCount: 5,
    pendingTraceCount: 2,
    tokens: 14_470,
  },
];

class BillingQueryRepositoryStub implements BillingQueryRepository {
  async aggregateMonth(): Promise<BillingMonthAggregate> {
    return { lines: [], pendingPrice: { traceCount: 0, tokens: {}, models: [] } };
  }

  async listBills(): Promise<BillRow[]> {
    return makeRows();
  }
}

const makeSut = (now = new Date('2026-07-19T12:00:00.000Z')) => {
  const billingQueryRepositoryStub = new BillingQueryRepositoryStub();
  const sut = new ListBillsDbUseCase({
    billingQueryRepository: billingQueryRepositoryStub,
    now: () => now,
  });

  return { sut, billingQueryRepositoryStub };
};

describe('ListBillsDbUseCase', () => {
  it('MUST return the repository bills unchanged, most recent first', async () => {
    const { sut } = makeSut();

    const bills = await sut.list();

    expect(bills.map((bill) => [bill.year, bill.month])).toEqual([
      [2026, 7],
      [2026, 6],
    ]);
    expect(bills[0]).toMatchObject({
      totalCostMicrocents: 8_000_000,
      stampedTraceCount: 13,
      pendingTraceCount: 1,
      tokens: 21_038,
    });
  });

  it('MUST mark ONLY the current UTC month as in_progress (invariant 8)', async () => {
    const { sut } = makeSut(new Date('2026-07-19T12:00:00.000Z'));

    const bills = await sut.list();

    expect(bills[0]?.periodStatus).toBe('in_progress');
    expect(bills[1]?.periodStatus).toBe('open');
  });

  it('MUST mark every bill open when the current month has no traces', async () => {
    const { sut } = makeSut(new Date('2026-08-02T00:00:00.000Z'));

    const bills = await sut.list();

    expect(bills.every((bill) => bill.periodStatus === 'open')).toBe(true);
  });
});
