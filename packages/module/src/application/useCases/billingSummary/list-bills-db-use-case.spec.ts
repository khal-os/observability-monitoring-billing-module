import { ListBillsDbUseCase } from './list-bills-db-use-case.js';
import { GetBillingSummaryDbUseCase } from './get-billing-summary-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from '../billingLifecycle/reopen-billing-period-db-use-case.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  QuarantineReconcilerStub,
  StubBillingQueryRepository,
  billRow,
  usageRecord,
} from '@observability/core/application/testSupport/billing-test-fakes.js';
import { RecordingLogger } from '@observability/core/common/logging/logging-test-fakes.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

const makeSut = (now = NOW) => {
  const billingQueryRepository = new StubBillingQueryRepository();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingSnapshotRepository = new InMemoryBillingSnapshotRepository(
    billingPeriodRepository,
  );
  const logger = new RecordingLogger();

  const sut = new ListBillsDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    now: () => now,
    logger,
  });

  const close = new CloseBillingPeriodDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    traceRepository: new QuarantineReconcilerStub(),
    now: () => now,
  });

  const reopen = new ReopenBillingPeriodDbUseCase({
    billingPeriodRepository,
    now: () => now,
  });

  // The same store, read through the OTHER endpoint — the two must never
  // disagree about a month's money (invariant 3).
  const summary = new GetBillingSummaryDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    now: () => now,
  });

  return {
    sut,
    logger,
    close,
    reopen,
    summary,
    billingQueryRepository,
    billingPeriodRepository,
  };
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

    expect(bills.find((bill) => bill.month === 6)?.quarantinedTraceCount).toBe(
      3,
    );
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
      const { sut, billingQueryRepository, billingPeriodRepository } =
        makeSut();
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
      const { sut, billingQueryRepository, billingPeriodRepository } =
        makeSut();

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

  describe('re-audit: REOPENING the EARLIEST closed month must not hide it', () => {
    const seedMayAndJune = (
      billingQueryRepository: StubBillingQueryRepository,
    ) => {
      billingQueryRepository.usageByMonth.set('2026-5', [
        usageRecord({
          traceId: 'may-1',
          startedAt: new Date('2026-05-10T12:00:00.000Z'),
        }),
        usageRecord({
          traceId: 'may-2',
          startedAt: new Date('2026-05-12T12:00:00.000Z'),
        }),
      ]);
      billingQueryRepository.usageByMonth.set('2026-6', [
        usageRecord({ traceId: 'jun-1' }),
      ]);
      billingQueryRepository.billRows = [
        billRow({
          year: 2026,
          month: 6,
          totalCostMicrocents: 2_500_000_000,
          stampedTraceCount: 1,
          tokens: 1_000_000,
          stampedTokens: 1_000_000,
        }),
        billRow({
          year: 2026,
          month: 5,
          totalCostMicrocents: 5_000_000_000,
          stampedTraceCount: 2,
          tokens: 2_000_000,
          stampedTokens: 2_000_000,
        }),
      ];
    };

    it('the reopened month stays in the list with its LIVE total, and the summary agrees', async () => {
      const { sut, close, reopen, summary, billingQueryRepository } = makeSut();
      seedMayAndJune(billingQueryRepository);

      await close.close(2026, 5);
      await close.close(2026, 6);
      // The audited correction flow (decision 89) on the OLDEST closed
      // month: the C-7.1 bound walked forward from the earliest STILL
      // closed month (June), so May fell behind the scan and vanished.
      await reopen.reopen(2026, 5, 'corrigir atribuição de maio');

      const bills = await sut.list();
      const may = bills.find((bill) => bill.month === 5);

      expect(bills.map((bill) => [bill.month, bill.periodStatus])).toEqual([
        [6, 'closed'],
        [5, 'open'],
      ]);
      expect(may?.totalCostMicrocents).toBe(5_000_000_000);
      expect(may?.stampedTraceCount).toBe(2);
      // Invariant 3: the two endpoints of the same truth agree.
      expect((await summary.get(2026, 5)).statement.totalCostMicrocents).toBe(
        may?.totalCostMicrocents,
      );
    });

    it('the reopened month reports the SAME pending count on /bills, /billing/summary and the close guard', async () => {
      const { sut, close, reopen, summary, billingQueryRepository } = makeSut();
      seedMayAndJune(billingQueryRepository);

      await close.close(2026, 5);
      await close.close(2026, 6);

      // A post-close straggler lands in May, still unpriced: quarantined
      // and unresolved. While May is FROZEN it is outside the bill
      // (decision 100) — countQuarantined carries it.
      billingQueryRepository.quarantinedPendingByMonth.set('2026-5', {
        traceCount: 1,
        tokens: { input: 40 },
        models: ['openai/gpt-9'],
      });

      const frozen = await sut.list();

      expect(frozen.find((bill) => bill.month === 5)?.pendingTraceCount).toBe(
        0,
      );
      expect((await summary.get(2026, 5)).pendingPrice.traceCount).toBe(0);

      // Reopened, the live statement bills May again — so the straggler is
      // an OPEN cost of that same live bill. All three readers of the one
      // truth must say so (invariant 3): the list, the statement, and the
      // guard that refuses the re-close until it is priced.
      await reopen.reopen(2026, 5, 'corrigir atribuição de maio');

      const bills = await sut.list();
      const may = bills.find((bill) => bill.month === 5);
      const live = await summary.get(2026, 5);

      expect(may?.pendingTraceCount).toBe(1);
      expect(live.pendingPrice.traceCount).toBe(1);
      expect(may?.pendingTraceCount).toBe(live.pendingPrice.traceCount);
      await expect(close.close(2026, 5)).rejects.toMatchObject({
        pendingTraceCount: 1,
      });
    });

    it('defence in depth: a NON-closed period doc outside the scan is LOUD, never a silent drop', async () => {
      const { sut, close, reopen, billingQueryRepository } = makeSut();
      seedMayAndJune(billingQueryRepository);

      await close.close(2026, 5);
      await reopen.reopen(2026, 5, 'corrigir atribuição de maio');

      // The shape a bound regression takes: the store still holds May's
      // traces, but the bounded scan answers no row for it.
      billingQueryRepository.billRows = [];

      await expect(sut.list()).rejects.toThrow(/outside the live scan bound/);
    });

    it('a reopened month with no traces LEFT in the store lists as an honest zero', async () => {
      const { sut, close, reopen, billingQueryRepository } = makeSut();
      billingQueryRepository.billRows = [];
      billingQueryRepository.usageByMonth.set('2026-5', [
        usageRecord({ traceId: 'may-1' }),
      ]);

      await close.close(2026, 5);
      await reopen.reopen(2026, 5, 'corrigir atribuição de maio');
      billingQueryRepository.usageByMonth.delete('2026-5');
      billingQueryRepository.quarantinedByMonth.set('2026-5', 2);

      const bills = await sut.list();

      expect(bills).toHaveLength(1);
      expect(bills[0]).toMatchObject({
        year: 2026,
        month: 5,
        periodStatus: 'open',
        totalCostMicrocents: 0,
        stampedTraceCount: 0,
        quarantinedTraceCount: 2,
      });
    });
  });

  /**
   * Re-audit iteration 3 — the THIRD variant of one root defect: the bound
   * used to be derived from period DOCUMENTS alone, and a month no
   * lifecycle action ever touched has none. Closing June with an empty May
   * is legal (the close-order guard passes on a trace-free month), and a
   * later backfill over May (`make sync FROM=… TO=…`, the README's
   * dead-letter recovery) is a documented Day-2 operation — so the state
   * is reachable by the front door, and the leftover pass cannot catch it
   * because May owns no document to iterate.
   */
  describe('re-audit iteration 3: a NEVER-closed month that gains traces AFTER a newer month closed', () => {
    const MAY_LATE = usageRecord({
      traceId: 'may-late-1',
      startedAt: new Date('2026-05-20T12:00:00.000Z'),
      stampedCosts: [
        {
          tokenType: 'input',
          tokens: 4_000_000,
          appliedPriceMicrocentsPerMillion: 2_500_000_000,
          appliedPriceEffectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
          costMicrocents: 10_000_000_000,
        },
      ],
      totalCostMicrocents: 10_000_000_000,
    });

    const closeJuneThenBackfillMay = async (
      billingQueryRepository: StubBillingQueryRepository,
      close: ReturnType<typeof makeSut>['close'],
    ) => {
      // The deployment syncs from mid-June on: May holds nothing, so the
      // close-order guard has nothing to block on.
      billingQueryRepository.usageByMonth.set('2026-6', [
        usageRecord({ traceId: 'jun-1' }),
      ]);
      billingQueryRepository.billRows = [
        billRow({
          year: 2026,
          month: 6,
          totalCostMicrocents: 2_500_000_000,
          stampedTraceCount: 1,
          tokens: 1_000_000,
          stampedTokens: 1_000_000,
        }),
      ];

      await close.close(2026, 6);

      // Day 2: the operator backfills the window the upstream source still
      // retains (~49 days). May was never closed, so the trace is NOT
      // quarantined — it is stamped and billed live.
      billingQueryRepository.usageByMonth.set('2026-5', [MAY_LATE]);
      billingQueryRepository.billRows.push(
        billRow({
          year: 2026,
          month: 5,
          totalCostMicrocents: 10_000_000_000,
          stampedTraceCount: 1,
          tokens: 4_000_000,
          stampedTokens: 4_000_000,
        }),
      );
    };

    it('/bills lists it with its LIVE total, and /billing/summary agrees (invariant 3)', async () => {
      const { sut, close, summary, billingQueryRepository } = makeSut();

      await closeJuneThenBackfillMay(billingQueryRepository, close);

      const bills = await sut.list();
      const may = bills.find((bill) => bill.month === 5);

      expect(bills.map((bill) => [bill.month, bill.periodStatus])).toEqual([
        [6, 'closed'],
        [5, 'open'],
      ]);
      expect(may?.totalCostMicrocents).toBe(10_000_000_000);
      expect(may?.stampedTraceCount).toBe(1);
      expect(may?.stampedTokens).toBe(4_000_000);
      // The other reader of the same store must report the same money —
      // the divergence this variant produced was /summary billing R$ 100
      // 000,00 for a month /bills did not list at all.
      expect((await summary.get(2026, 5)).statement.totalCostMicrocents).toBe(
        may?.totalCostMicrocents,
      );
      // June stays frozen at its snapshot.
      expect(bills.find((bill) => bill.month === 6)?.totalCostMicrocents).toBe(
        2_500_000_000,
      );
    });

    it('the scan bound moves back onto the month — no period document exists to betray it', async () => {
      const { sut, close, billingQueryRepository } = makeSut();
      const spy = jest.spyOn(billingQueryRepository, 'listBills');

      await closeJuneThenBackfillMay(billingQueryRepository, close);
      await sut.list();

      // Anchored on the earliest STORED trace, not on the earliest CLOSED
      // month: the old bound was 2026-07-01 and cut May out entirely.
      // Decision 130: every boundary below is a CLIENT midnight (03:00Z
      // under the suite's America/Sao_Paulo clock).
      expect(spy).toHaveBeenLastCalledWith(
        new Date('2026-05-01T03:00:00.000Z'),
        [
          {
            start: new Date('2026-06-01T03:00:00.000Z'),
            end: new Date('2026-07-01T03:00:00.000Z'),
          },
        ],
      );
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
    // from period docs + snapshots, never re-scanned. The second argument
    // is the frozen-month scope of the pending lens (re-audit iteration
    // 2): it must name exactly the CLOSED months, so an open or reopened
    // month never inherits the frozen reading of its stragglers.
    // Decision 130: client midnights (03:00Z under the suite clock).
    expect(spy).toHaveBeenLastCalledWith(new Date('2026-07-01T03:00:00.000Z'), [
      {
        start: new Date('2026-06-01T03:00:00.000Z'),
        end: new Date('2026-07-01T03:00:00.000Z'),
      },
    ]);
  });

  it('MUST exclude a FUTURE-dated month from the bill list — /billing/summary 400s it, so listing it offered a row the UI could never open (audit B-1)', async () => {
    const { sut, billingQueryRepository, logger } = makeSut();

    billingQueryRepository.billRows = [
      billRow({ year: 2026, month: 7 }),
      // One trace with startedAt in 2027 (source clock skew) mints a row.
      billRow({ year: 2027, month: 5 }),
    ];

    const bills = await sut.list();

    expect(bills.map((bill) => `${bill.year}-${bill.month}`)).toEqual([
      '2026-7',
    ]);
    expect(logger.messages('warn').join('\n')).toContain('FUTURO');
  });
});
