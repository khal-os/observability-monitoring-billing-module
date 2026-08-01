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
  collectAppliedPriceVersions,
} from '../billingStatement/statement-engine.js';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../domain/models/billing-snapshot-model.js';
import { BillingPeriodAuditEntry } from '../../../domain/models/billing-period-model.js';

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

  describe('re-audit decision 112: months close OLDEST-FIRST', () => {
    const MAY = [
      usageRecord({
        traceId: 'may-1',
        startedAt: new Date('2026-05-10T12:00:00.000Z'),
      }),
    ];

    it('MUST block closing JUNE while a trace-bearing MAY was never closed, naming May', async () => {
      const {
        sut,
        billingQueryRepository,
        billingPeriodRepository,
        billingSnapshotRepository,
        traceRepository,
      } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-5', MAY);
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      const error = await sut.close(2026, 6).catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BillingCloseBlockedError);
      // The runbook prints this verbatim — it must name the month to
      // close first (out-of-order closes hid the skipped month's money
      // behind the C-7.1 live-scan bound).
      expect((error as Error).message).toContain('2026-05');
      // Nothing half-done: no period flip, no snapshot, no adjudication.
      expect(await billingPeriodRepository.find(2026, 6)).toBeNull();
      expect(await billingSnapshotRepository.findCurrent(2026, 6)).toBeNull();
      expect(traceRepository.calls).toEqual([]);
    });

    it('closing in order — May then June — is never blocked', async () => {
      const { sut, billingQueryRepository } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-5', MAY);
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      await expect(sut.close(2026, 5)).resolves.toMatchObject({
        snapshotVersion: 1,
      });
      await expect(sut.close(2026, 6)).resolves.toMatchObject({
        snapshotVersion: 1,
      });
    });

    it('a genuinely trace-free older month does NOT block — a no-traffic gap passes', async () => {
      const { sut, billingQueryRepository } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-4', [
        usageRecord({
          traceId: 'apr-1',
          startedAt: new Date('2026-04-10T12:00:00.000Z'),
        }),
      ]);
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      await sut.close(2026, 4);

      // May has no trace at all and therefore no lifecycle document — the
      // guard must let it pass instead of demanding a close for a month
      // that never existed.
      await expect(sut.close(2026, 6)).resolves.toMatchObject({
        snapshotVersion: 1,
      });
    });
  });

  describe('re-audit decision 112: the already-closed retry REPAIRS the reconciliation', () => {
    it('re-runs the reconciliation from the CURRENT snapshot ids, then still refuses', async () => {
      const { sut, billingQueryRepository, traceRepository } = makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      await sut.close(2026, 6);

      expect(traceRepository.calls).toHaveLength(1);

      // The live store drifted after the close (a straggler arrived): the
      // repair must reconcile from the DURABLE snapshot usage ids, never
      // from a fresh live read.
      billingQueryRepository.usageByMonth.set('2026-6', [
        ...JUNE,
        usageRecord({ traceId: 't3-straggler' }),
      ]);

      const error = await sut.close(2026, 6).catch((thrown) => thrown);

      // Exit semantics unchanged: the runbook still sees already-closed.
      expect(error).toBeInstanceOf(BillingPeriodStateError);
      expect((error as Error).message).toMatch(/já está fechado/);
      expect((error as Error).message).toMatch(
        /Reconciliação de quarentena reverificada/,
      );
      // ...but the idempotent reconciliation ran a SECOND time first — the
      // recovery for a close that crashed between the committed
      // transaction and the reconciliation.
      expect(traceRepository.calls).toHaveLength(2);
      expect(traceRepository.calls[1]).toEqual({
        monthStart: new Date('2026-06-01T00:00:00.000Z'),
        monthEnd: new Date('2026-07-01T00:00:00.000Z'),
        snapshotTraceIds: ['t1', 't2'],
        snapshotVersion: 1,
      });
    });

    it('a closed period doc with NO snapshot version has nothing durable to repair from — plain refusal', async () => {
      const { sut, billingPeriodRepository, traceRepository } = makeSut();
      billingPeriodRepository.periods.set('2026-6', {
        year: 2026,
        month: 6,
        status: 'closed',
        closedAt: NOW,
        audit: [],
      });

      await expect(sut.close(2026, 6)).rejects.toThrow(BillingPeriodStateError);
      expect(traceRepository.calls).toEqual([]);
    });
  });

  describe('re-audit: the pending guard is the LIVE-month lens (decisions 89/100/113)', () => {
    it('MUST block the RE-close of a reopened month holding a quarantined pending_price trace', async () => {
      const { sut, reopen, billingQueryRepository, billingSnapshotRepository } =
        makeSut();
      billingQueryRepository.usageByMonth.set('2026-6', JUNE);

      await sut.close(2026, 6);

      // A June straggler arrives after the close and lands quarantined —
      // and pending, because its model has no registered price.
      billingQueryRepository.quarantinedPendingByMonth.set('2026-6', {
        traceCount: 1,
        tokens: { input: 500_000 },
        models: ['openai/gpt-9'],
      });

      // While June stays CLOSED the straggler is outside the frozen bill
      // (decision 100): the refusal is about the state, not the pending.
      await expect(sut.close(2026, 6)).rejects.toThrow(BillingPeriodStateError);

      await reopen.reopen(2026, 6, 'faturar retardatários de junho');

      // Reopened ⇒ the month is billed LIVE again, so the straggler is an
      // OPEN cost: v2 must not freeze without it (decision 89 IS this
      // correction flow — register the price, reprocess, then close).
      const error = await sut.close(2026, 6).catch((thrown) => thrown);

      expect(error).toBeInstanceOf(BillingCloseBlockedError);
      expect((error as BillingCloseBlockedError).pendingTraceCount).toBe(1);
      expect((error as Error).message).toContain('openai/gpt-9');
      expect(
        (await billingSnapshotRepository.findCurrent(2026, 6))?.version,
      ).toBe(1);
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

  describe('re-audit iteration 3: the close folds the month PAGE BY PAGE', () => {
    /**
     * Spread over three UTC days, with traceIds whose global order is the
     * REVERSE of the day order: the paged fold therefore sees the records
     * in a different order than the whole-month array did — which is
     * exactly the property the byte-identity of the statement rests on
     * (the engine is order-independent by contract).
     */
    const SPREAD = [
      usageRecord({
        traceId: 'z-1',
        startedAt: new Date('2026-06-02T01:00:00.000Z'),
      }),
      usageRecord({
        traceId: 'z-2',
        agentId: 'suporte',
        startedAt: new Date('2026-06-02T22:30:00.000Z'),
      }),
      usageRecord({
        traceId: 'm-1',
        model: 'anthropic/claude-haiku-4-5',
        startedAt: new Date('2026-06-17T09:00:00.000Z'),
      }),
      usageRecord({
        traceId: 'm-2',
        startedAt: new Date('2026-06-17T23:59:59.000Z'),
      }),
      usageRecord({
        traceId: 'a-1',
        agentId: 'suporte',
        model: 'anthropic/claude-haiku-4-5',
        startedAt: new Date('2026-06-28T12:00:00.000Z'),
      }),
    ];

    /** Records every window the close reads. */
    class WindowRecordingQueryRepository extends StubBillingQueryRepository {
      readonly windows: { start: Date; end: Date }[] = [];

      override async fetchUsageRecords(
        monthStart: Date,
        monthEnd?: Date,
      ): Promise<BillingUsageRecord[]> {
        this.windows.push({ start: monthStart, end: monthEnd as Date });

        return super.fetchUsageRecords(monthStart, monthEnd);
      }
    }

    /** Records every page the close hands to the staging phase. */
    class PageRecordingSnapshotRepository extends InMemoryBillingSnapshotRepository {
      readonly pageSizes: number[] = [];

      override async insertWithPeriodCloseStaged(
        identity: { year: number; month: number; version: number },
        stageAndBuild: (
          stage: (page: BillingUsageRecord[]) => Promise<void>,
        ) => Promise<BillingSnapshotModel>,
        close: { closedAt: Date; audit: BillingPeriodAuditEntry },
      ): Promise<'closed' | 'conflict'> {
        return super.insertWithPeriodCloseStaged(
          identity,
          async (stage) =>
            stageAndBuild(async (page) => {
              this.pageSizes.push(page.length);

              await stage(page);
            }),
          close,
        );
      }
    }

    const makePagedSut = () => {
      const billingQueryRepository = new WindowRecordingQueryRepository();
      const billingPeriodRepository = new InMemoryBillingPeriodRepository();
      const billingSnapshotRepository = new PageRecordingSnapshotRepository(
        billingPeriodRepository,
      );
      const traceRepository = new QuarantineReconcilerStub();

      billingQueryRepository.usageByMonth.set('2026-6', SPREAD);

      return {
        sut: new CloseBillingPeriodDbUseCase({
          billingQueryRepository,
          billingPeriodRepository,
          billingSnapshotRepository,
          traceRepository,
          now: () => NOW,
        }),
        billingQueryRepository,
        billingSnapshotRepository,
        traceRepository,
      };
    };

    it('MUST read and stage the month one DAY at a time — never the whole month at once', async () => {
      const { sut, billingQueryRepository, billingSnapshotRepository } =
        makePagedSut();

      await sut.close(2026, 6);

      // June has 30 days: one indexed range per page, none of them the
      // month. Materializing the month is what killed the close — the
      // api service is capped at 512m (a ~259 MB heap) and the process
      // died with "Reached heap limit" at ~200k stamped traces,
      // deterministically, so the month could never close and every
      // later month stayed blocked behind it (invariant 8).
      expect(billingQueryRepository.windows).toHaveLength(30);
      expect(
        billingQueryRepository.windows.every(
          (window) =>
            window.end.getTime() - window.start.getTime() === 24 * 3_600_000,
        ),
      ).toBe(true);

      // The staged pages are days too — the peak is the busiest DAY.
      expect(billingSnapshotRepository.pageSizes).toEqual([2, 2, 1]);
      expect(Math.max(...billingSnapshotRepository.pageSizes)).toBeLessThan(
        SPREAD.length,
      );
    });

    it('the PAGED statement is byte-identical to the whole-month one, and the snapshot still reproduces', async () => {
      const { sut, billingSnapshotRepository } = makePagedSut();

      const result = await sut.close(2026, 6);

      const stored = await billingSnapshotRepository.findCurrent(2026, 6);
      const storedInputs = await billingSnapshotRepository.findUsageRecords(
        2026,
        6,
        1,
      );

      // The engine over the WHOLE month, in the traceId order the
      // unpaged close used — the fold must not move a single byte
      // (LOGIC_VERSION therefore stays put: no arithmetic changed).
      const wholeMonth = buildStatement(
        [...SPREAD].sort((a, b) => (a.traceId < b.traceId ? -1 : 1)),
      );

      expect(JSON.parse(JSON.stringify(stored?.statement))).toEqual(
        JSON.parse(JSON.stringify(wholeMonth)),
      );
      expect(stored?.logicVersion).toBe(STATEMENT_LOGIC_VERSION);
      expect(stored?.usageRecordCount).toBe(SPREAD.length);
      expect(result.totalCostMicrocents).toBe(wholeMonth.totalCostMicrocents);
      expect(result.totalDisplayCents).toBe(wholeMonth.totalDisplayCents);
      expect(result.stampedTraceCount).toBe(SPREAD.length);

      // REPRODUCIBILITY (T6) survives paging: the stored inputs are the
      // month, each record exactly once, and they reproduce the output.
      expect(storedInputs.map((record) => record.traceId).sort()).toEqual([
        'a-1',
        'm-1',
        'm-2',
        'z-1',
        'z-2',
      ]);
      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });

    it('the applied price versions and the reconciled ids come from the SAME fold — every trace, once', async () => {
      const { sut, billingSnapshotRepository, traceRepository } =
        makePagedSut();

      await sut.close(2026, 6);

      const stored = await billingSnapshotRepository.findCurrent(2026, 6);

      expect(
        JSON.parse(JSON.stringify(stored?.priceVersionsApplied)),
      ).toEqual(JSON.parse(JSON.stringify(collectAppliedPriceVersions(SPREAD))));
      expect(traceRepository.calls[0]?.snapshotTraceIds.slice().sort()).toEqual(
        ['a-1', 'm-1', 'm-2', 'z-1', 'z-2'],
      );
    });
  });
});
