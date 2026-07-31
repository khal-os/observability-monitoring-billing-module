import { ListBillsDbUseCase } from './list-bills-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  StubBillingQueryRepository,
  usageRecord,
} from '../billingStatement/billing-test-fakes.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

const makeSut = (now = NOW) => {
  const billingQueryRepository = new StubBillingQueryRepository();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingSnapshotRepository = new InMemoryBillingSnapshotRepository();

  const sut = new ListBillsDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    now: () => now,
  });

  const close = new CloseBillingPeriodDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    now: () => now,
  });

  return { sut, close, billingQueryRepository };
};

const seedRows = (billingQueryRepository: StubBillingQueryRepository) => {
  billingQueryRepository.billRows = [
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
      pendingTraceCount: 0,
      tokens: 14_470,
    },
  ];
};

describe('ListBillsDbUseCase (T7)', () => {
  it('labels current month in_progress, past open months open — most recent first', async () => {
    const { sut, billingQueryRepository } = makeSut();
    seedRows(billingQueryRepository);

    const bills = await sut.list();

    expect(
      bills.map((bill) => [bill.year, bill.month, bill.periodStatus]),
    ).toEqual([
      [2026, 7, 'in_progress'],
      [2026, 6, 'open'],
    ]);
    expect(bills[1]).toMatchObject({
      totalCostMicrocents: 8_220_000,
      stampedTraceCount: 5,
      quarantinedTraceCount: 0,
    });
  });

  it('MUST mark every bill open when the current month has no traces', async () => {
    const { sut, billingQueryRepository } = makeSut(
      new Date('2026-08-02T00:00:00.000Z'),
    );
    seedRows(billingQueryRepository);

    const bills = await sut.list();

    expect(bills.every((bill) => bill.periodStatus === 'open')).toBe(true);
  });

  it('a CLOSED month reports the SNAPSHOT numbers verbatim, not the live rollup (US6)', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    seedRows(billingQueryRepository);
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    await close.close(2026, 6);

    // The live rollup drifts after the close (late arrivals) — the bill must not.
    const june = billingQueryRepository.billRows[1];
    if (june) june.totalCostMicrocents = 999;
    billingQueryRepository.quarantinedByMonth.set('2026-6', 1);

    const bills = await sut.list();
    const juneBill = bills.find((bill) => bill.month === 6);

    expect(juneBill?.periodStatus).toBe('closed');
    expect(juneBill?.totalCostMicrocents).toBe(2_500_000_000);
    expect(juneBill?.snapshotVersion).toBe(1);
    expect(juneBill?.closedAt).toEqual(NOW);
    expect(juneBill?.quarantinedTraceCount).toBe(1);
  });

  it('a closed month with zero traces left in the store still bills from its snapshot', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    billingQueryRepository.billRows = [];
    billingQueryRepository.usageByMonth.set('2026-5', [
      usageRecord({ traceId: 'x' }),
    ]);

    await close.close(2026, 5);
    billingQueryRepository.usageByMonth.delete('2026-5');

    const bills = await sut.list();

    expect(bills).toHaveLength(1);
    expect(bills[0]).toMatchObject({
      year: 2026,
      month: 5,
      periodStatus: 'closed',
      totalCostMicrocents: 2_500_000_000,
    });
  });
});
