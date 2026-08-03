import { CloseBillingPeriodDbUseCase } from './close-billing-period-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from './reopen-billing-period-db-use-case.js';
import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
} from './billing-lifecycle-protocols.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  QuarantineReconcilerStub,
  StubBillingQueryRepository,
  usageRecord,
} from '../billingStatement/billing-test-fakes.js';
import {
  STATEMENT_LOGIC_VERSION,
  buildStatement,
} from '../billingStatement/statement-engine.js';

const NOW = new Date('2026-07-15T10:00:00.000Z');

const makeSut = () => {
  const billingQueryRepository = new StubBillingQueryRepository();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingSnapshotRepository = new InMemoryBillingSnapshotRepository(
    billingPeriodRepository,
  );
  const traceRepository = new QuarantineReconcilerStub();

  const sut = new CloseBillingPeriodDbUseCase({
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    traceRepository,
    now: () => NOW,
  });

  const reopen = new ReopenBillingPeriodDbUseCase({
    billingPeriodRepository,
    now: () => NOW,
  });

  return {
    sut,
    reopen,
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
    traceRepository,
  };
};

const JUNE = [
  usageRecord({ traceId: 't1' }),
  usageRecord({
    traceId: 't2',
    agentId: 'suporte',
    model: 'anthropic/claude-haiku-4-5',
    stampedCosts: [
      {
        tokenType: 'input',
        tokens: 3_000_000,
        appliedPriceMicrocentsPerMillion: 440_000_000,
        appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        costMicrocents: 1_320_000_000,
      },
      {
        tokenType: 'cache_read',
        tokens: 500_000,
        appliedPriceMicrocentsPerMillion: 44_000_000,
        appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        costMicrocents: 22_000_000,
      },
    ],
    totalCostMicrocents: 1_342_000_000,
  }),
];

describe('CloseBillingPeriodDbUseCase (T6)', () => {
  it('MUST freeze inputs and output: snapshot statement ≡ engine over the month records', async () => {
    const { sut, billingQueryRepository, billingSnapshotRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', JUNE);
    billingQueryRepository.watermarkByMonth.set(
      '2026-6',
      new Date('2026-07-01T02:00:00.000Z'),
    );

    const result = await sut.close(2026, 6);

    const snapshot = await billingSnapshotRepository.findCurrent(2026, 6);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.version).toBe(1);
    expect(snapshot?.logicVersion).toBe(STATEMENT_LOGIC_VERSION);
    expect(snapshot?.usageRecordCount).toBe(2);
    expect(result.totalCostMicrocents).toBe(
      snapshot?.statement.totalCostMicrocents,
    );
  });

  it('REPRODUCIBILITY ACCEPTANCE (T6): the engine over the SNAPSHOT inputs reproduces the output to the cent', async () => {
    const { sut, billingQueryRepository, billingSnapshotRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', JUNE);

    await sut.close(2026, 6);

    const storedInputs = await billingSnapshotRepository.findUsageRecords(
      2026,
      6,
      1,
    );
    const storedSnapshot = await billingSnapshotRepository.findCurrent(2026, 6);

    const reproduced = buildStatement(storedInputs);

    // EXACT equality — µ¢, reconciled display cents, shares, mix, cache:
    // the whole statement, byte for byte.
    expect(JSON.parse(JSON.stringify(reproduced))).toEqual(
      JSON.parse(JSON.stringify(storedSnapshot?.statement)),
    );
    expect(reproduced.totalDisplayCents).toBe(
      storedSnapshot?.statement.totalDisplayCents,
    );
  });

  it('MUST be BLOCKED while any pending_price trace exists in the month (T6)', async () => {
    const { sut, billingQueryRepository, billingPeriodRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', JUNE);
    billingQueryRepository.pendingByMonth.set('2026-6', {
      traceCount: 3,
      tokens: { input: 500 },
      models: ['meta/llama-4-scout'],
    });

    await expect(sut.close(2026, 6)).rejects.toThrow(BillingCloseBlockedError);
    // Nothing half-done: no snapshot, period still open.
    expect(await billingPeriodRepository.find(2026, 6)).toBeNull();
  });

  it('MUST refuse to close the current (or a future) month — invariant 8', async () => {
    const { sut } = makeSut();

    await expect(sut.close(2026, 7)).rejects.toThrow(BillingPeriodStateError);
    await expect(sut.close(2027, 1)).rejects.toThrow(BillingPeriodStateError);
  });

  it('MUST refuse to close an already-closed month', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', JUNE);

    await sut.close(2026, 6);

    await expect(sut.close(2026, 6)).rejects.toThrow(BillingPeriodStateError);
  });

  it('reopen → re-close writes version 2 and PRESERVES version 1 (T6 audit)', async () => {
    const {
      sut,
      reopen,
      billingQueryRepository,
      billingPeriodRepository,
      billingSnapshotRepository,
    } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', JUNE);

    await sut.close(2026, 6);
    await reopen.reopen(2026, 6, 'correção de atribuição do agente suporte');

    const reopened = await billingPeriodRepository.find(2026, 6);
    expect(reopened?.status).toBe('open');
    expect(reopened?.audit.map((entry) => entry.action)).toEqual([
      'close',
      'reopen',
    ]);
    expect(reopened?.audit[1]?.reason).toBe(
      'correção de atribuição do agente suporte',
    );

    // A late correction changed the month's records before the re-close.
    billingQueryRepository.usageByMonth.set('2026-6', [
      ...JUNE,
      usageRecord({ traceId: 't3-late' }),
    ]);

    const second = await sut.close(2026, 6);

    expect(second.snapshotVersion).toBe(2);
    expect(await billingSnapshotRepository.findVersion(2026, 6, 1)).not.toBeNull();
    expect(
      (await billingSnapshotRepository.findCurrent(2026, 6))?.statement
        .stampedTraceCount,
    ).toBe(3);
  });

  it('reopen MUST demand a reason and a closed month', async () => {
    const { reopen } = makeSut();

    await expect(reopen.reopen(2026, 6, '  ')).rejects.toThrow(
      BillingPeriodStateError,
    );
    await expect(reopen.reopen(2026, 6, 'motivo')).rejects.toThrow(
      BillingPeriodStateError,
    );
  });

  it('an empty month closes honestly: zero total, zero records, snapshot still written', async () => {
    const { sut, billingSnapshotRepository } = makeSut();

    const result = await sut.close(2026, 5);

    expect(result.totalCostMicrocents).toBe(0);
    expect(result.stampedTraceCount).toBe(0);
    expect(
      (await billingSnapshotRepository.findCurrent(2026, 5))?.statement.lines,
    ).toEqual([]);
  });

  describe('audit B-1 (decision 100): the snapshot adjudicates', () => {
    it('MUST reconcile quarantine AFTER the close, with the snapshot ids and version', async () => {
      const { sut, billingQueryRepository, traceRepository } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);
      traceRepository.result = { flaggedStragglers: 2, absorbed: 1 };

      const result = await sut.close(2026, 6);

      expect(traceRepository.calls).toEqual([
        {
          monthStart: new Date('2026-06-01T00:00:00.000Z'),
          monthEnd: new Date('2026-07-01T00:00:00.000Z'),
          snapshotTraceIds: ['t1', 't2'],
          snapshotVersion: 1,
        },
      ]);
      expect(result.quarantine).toEqual({ flaggedStragglers: 2, absorbed: 1 });
    });

    it('MUST NOT reconcile when the close is blocked or loses — no snapshot, no adjudication', async () => {
      const { sut, billingQueryRepository, traceRepository } = makeSut();
      billingQueryRepository.pendingByMonth.set('2026-6', {
        traceCount: 1,
        tokens: { input: 10 },
        models: ['m'],
      });

      await expect(sut.close(2026, 6)).rejects.toThrow(BillingCloseBlockedError);
      expect(traceRepository.calls).toEqual([]);
    });
  });

  describe('audit B-2 (M8): the close is one atomic write', () => {
    it('CRASH between snapshot writes and the period flip: NOTHING lands, the retry closes cleanly and reproduces', async () => {
      const {
        sut,
        billingQueryRepository,
        billingPeriodRepository,
        billingSnapshotRepository,
      } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      jest
        .spyOn(billingPeriodRepository, 'markClosed')
        .mockRejectedValueOnce(new Error('crash before the flip'));

      await expect(sut.close(2026, 6)).rejects.toThrow('crash before the flip');

      // The one-transaction contract: no orphan snapshot, period untouched.
      expect(await billingSnapshotRepository.findCurrent(2026, 6)).toBeNull();
      expect(await billingPeriodRepository.find(2026, 6)).toBeNull();

      // The retry is NOT wedged (the old protocol recomputed the same
      // version over an orphan header and failed forever).
      const retried = await sut.close(2026, 6);

      expect(retried.snapshotVersion).toBe(1);

      const storedInputs = await billingSnapshotRepository.findUsageRecords(
        2026,
        6,
        1,
      );
      const stored = await billingSnapshotRepository.findCurrent(2026, 6);

      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });

    it('MUST derive a collision-proof version from the HIGHEST stored header too (orphan tolerated)', async () => {
      const { sut, billingQueryRepository, billingSnapshotRepository } =
        makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      // An orphan v1 header exists (pre-fix crash legacy): the period doc
      // never advanced, so the OLD derivation would recompute v1 and wedge
      // on the unique index forever.
      await billingSnapshotRepository.insert(
        {
          year: 2026,
          month: 6,
          version: 1,
          createdAt: NOW,
          trigger: 'runbook',
          ingestionWatermark: null,
          logicVersion: STATEMENT_LOGIC_VERSION,
          roundingRule: 'half-up 2 casas',
          statement: buildStatement([]),
          exceptions: [],
          priceVersionsApplied: [],
          usageRecordCount: 0,
        },
        [],
      );

      const result = await sut.close(2026, 6);

      expect(result.snapshotVersion).toBe(2);
      expect(
        (await billingSnapshotRepository.findCurrent(2026, 6))?.version,
      ).toBe(2);
    });

    it('a concurrent close losing the period flip surfaces as a clean state error, nothing overwritten', async () => {
      const { sut, billingQueryRepository, billingPeriodRepository } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      // The other runner wins between our guard read and our write.
      jest
        .spyOn(billingPeriodRepository, 'markClosed')
        .mockResolvedValueOnce('conflict');

      await expect(sut.close(2026, 6)).rejects.toThrow(BillingPeriodStateError);
    });
  });
});
