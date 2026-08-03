import { ListBillsDbUseCase } from './list-bills-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  QuarantineReconcilerStub,
  StubBillingQueryRepository,
  billRow,
  usageRecord,
} from '../billingStatement/billing-test-fakes.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

const makeSut = (now = NOW) => {
  const billingQueryRepository = new StubBillingQueryRepository();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingSnapshotRepository = new InMemoryBillingSnapshotRepository(
    billingPeriodRepository,
  );

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
    traceRepository: new QuarantineReconcilerStub(),
    now: () => now,
  });

  return { sut, close, billingQueryRepository, billingPeriodRepository };
};

const seedRows = (billingQueryRepository: StubBillingQueryRepository) => {
  billingQueryRepository.billRows = [
    billRow({
      year: 2026,
      month: 7,
      totalCostMicrocents: 8_000_000,
      stampedTraceCount: 13,
      pendingTraceCount: 1,
      tokens: 21_038,
      stampedTokens: 20_100,
    }),
    billRow({
      year: 2026,
      month: 6,
      totalCostMicrocents: 8_220_000,
      stampedTraceCount: 5,
      pendingTraceCount: 0,
      tokens: 14_470,
      stampedTokens: 14_470,
    }),
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

  it('audit B-10.4: exposes BOTH token figures — live volume and billed volume', async () => {
    const { sut, billingQueryRepository } = makeSut();
    seedRows(billingQueryRepository);

    const bills = await sut.list();

    expect(bills[0]).toMatchObject({ tokens: 21_038, stampedTokens: 20_100 });
    expect(bills[1]).toMatchObject({ tokens: 14_470, stampedTokens: 14_470 });
  });

  it('audit B-1: an OPEN month reports its live quarantine count, never a hardcoded zero (US5)', async () => {
    const { sut, billingQueryRepository } = makeSut();
    seedRows(billingQueryRepository);
    // Reopened-month scenario: unresolved quarantined traces exist while
    // the month is open — the admin must see them (decision 100).
    billingQueryRepository.quarantinedByMonth.set('2026-6', 3);

    const bills = await sut.list();

    expect(bills.find((bill) => bill.month === 6)?.quarantinedTraceCount).toBe(3);
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

    // The live rollup drifts after the close (late arrivals) — the bill
    // must not. (audit C-7.1: the live scan is bounded past the closed
    // month anyway; the drifted row below must never be read.)
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
    // audit B-10.4: the frozen bill knows only billed volume — the two
    // token figures are equal by construction, from the snapshot.
    expect(juneBill?.tokens).toBe(1_000_000);
    expect(juneBill?.stampedTokens).toBe(1_000_000);
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

  describe('audit B-10.2: a closed month with a MISSING snapshot throws — never a silent skip', () => {
    it('throws for a closed period with no live row (leftover branch)', async () => {
      const { sut, billingQueryRepository, billingPeriodRepository } = makeSut();
      billingQueryRepository.billRows = [];

      // Corrupt state: period closed, snapshot never written.
      await billingPeriodRepository.markClosed({
        year: 2026,
        month: 5,
        closedAt: NOW,
        snapshotVersion: 1,
        audit: {
          at: NOW,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });

      await expect(sut.list()).rejects.toThrow(/no snapshot/);
    });

    it('throws for a closed period WITH a live row (gap scenario keeps the row in the scan)', async () => {
      const { sut, billingQueryRepository, billingPeriodRepository } = makeSut();

      // April closed (with snapshot missing = corrupt), May open (the gap
      // puts the bound at May 1st)... so April is a leftover. To hit the
      // ROW branch instead, close JUNE without a snapshot while APRIL is
      // the closed month anchoring the bound before it.
      await billingPeriodRepository.markClosed({
        year: 2026,
        month: 4,
        closedAt: NOW,
        snapshotVersion: 1,
        audit: {
          at: NOW,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });
      await billingPeriodRepository.markClosed({
        year: 2026,
        month: 6,
        closedAt: NOW,
        snapshotVersion: 1,
        audit: {
          at: NOW,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });
      // Bound = May 1 (first non-closed month) → June's live row stays in
      // the scan and resolves through the row branch.
      billingQueryRepository.billRows = [
        billRow({ year: 2026, month: 6, stampedTraceCount: 1 }),
      ];

      await expect(sut.list()).rejects.toThrow(/no snapshot/);
    });
  });

  it('audit C-7.1: the live scan is bounded to the first open month', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    seedRows(billingQueryRepository);
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    const spy = jest.spyOn(billingQueryRepository, 'listBills');

    await close.close(2026, 6);
    await sut.list();

    // June closed ⇒ the scan starts at July 1 — closed history is served
    // from period docs + snapshots, never re-scanned.
    expect(spy).toHaveBeenLastCalledWith(new Date('2026-07-01T00:00:00.000Z'));
  });
});
