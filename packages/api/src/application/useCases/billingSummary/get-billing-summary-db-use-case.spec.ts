import {
  GetBillingSummaryDbUseCase,
  firstOpenMonthStart,
  monthWindowUtc,
  previousMonthOf,
} from './get-billing-summary-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import { BillingPeriodStateError } from '../../../domain/useCases/close-billing-period-use-case.js';
import { BillingPeriodModel } from '../../../domain/models/billing-period-model.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  QuarantineReconcilerStub,
  StubBillingQueryRepository,
  usageRecord,
} from '../billingStatement/billing-test-fakes.js';

const NOW = new Date('2026-07-19T12:00:00.000Z');

const makeSut = (now = NOW) => {
  const billingQueryRepository = new StubBillingQueryRepository();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingSnapshotRepository = new InMemoryBillingSnapshotRepository(
    billingPeriodRepository,
  );

  const sut = new GetBillingSummaryDbUseCase({
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

  const reopenPeriod = (year: number, month: number) =>
    billingPeriodRepository.markReopened({
      year,
      month,
      audit: {
        at: now,
        action: 'reopen',
        trigger: 'runbook',
        reason: 'correção',
        snapshotVersion: 1,
      },
    });

  return {
    sut,
    close,
    reopenPeriod,
    billingQueryRepository,
    billingPeriodRepository,
    billingSnapshotRepository,
  };
};

describe('monthWindowUtc()', () => {
  it('MUST build the half-open UTC calendar month window', () => {
    expect(monthWindowUtc(2026, 6)).toEqual({
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(monthWindowUtc(2026, 12).end).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  it('MUST reject malformed periods', () => {
    expect(() => monthWindowUtc(2026, 13)).toThrow();
    expect(() => monthWindowUtc(2026, 0)).toThrow();
    expect(() => monthWindowUtc(2026.5, 6)).toThrow();
  });

  it('previousMonthOf crosses the year boundary', () => {
    expect(previousMonthOf(2026, 1)).toEqual({ year: 2025, month: 12 });
    expect(previousMonthOf(2026, 7)).toEqual({ year: 2026, month: 6 });
  });
});

describe('firstOpenMonthStart() (audit C-7.1)', () => {
  const period = (
    year: number,
    month: number,
    status: 'open' | 'closed',
  ): BillingPeriodModel => ({ year, month, status, audit: [] });

  it('is null while no month ever closed (unbounded scan — PoC behavior)', () => {
    expect(firstOpenMonthStart([])).toBeNull();
    expect(firstOpenMonthStart([period(2026, 6, 'open')])).toBeNull();
  });

  it('is the month after a contiguous closed run', () => {
    expect(
      firstOpenMonthStart([period(2026, 5, 'closed'), period(2026, 6, 'closed')]),
    ).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('crosses the year boundary', () => {
    expect(firstOpenMonthStart([period(2026, 12, 'closed')])).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  it('a REOPENED (or skipped) month inside the run pulls the bound back — its live data must be scanned', () => {
    expect(
      firstOpenMonthStart([
        period(2026, 4, 'closed'),
        period(2026, 5, 'open'), // reopened
        period(2026, 6, 'closed'),
      ]),
    ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
  });
});

describe('GetBillingSummaryDbUseCase (T7)', () => {
  it('OPEN month: computes live via the engine — total ≡ sum of stamps (invariant 3)', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
      usageRecord({ traceId: 't2', agentId: 'suporte' }),
    ]);

    const summary = await sut.get(2026, 6);

    expect(summary.periodStatus).toBe('open');
    expect(summary.statement.totalCostMicrocents).toBe(5_000_000_000);
    expect(summary.statement.stampedTraceCount).toBe(2);
  });

  it('CURRENT month: labeled in_progress (invariant 8)', async () => {
    const { sut } = makeSut();

    expect((await sut.get(2026, 7)).periodStatus).toBe('in_progress');
  });

  it('audit B-10.3: a FUTURE month is a 400-class state error — never a legit-looking zero bill', async () => {
    const { sut } = makeSut();

    await expect(sut.get(2026, 8)).rejects.toThrow(BillingPeriodStateError);
    await expect(sut.get(2027, 1)).rejects.toThrow(BillingPeriodStateError);
    await expect(sut.get(2027, 1)).rejects.toThrow(/futuro/);
  });

  it('audit C-7.3: closed months list ALL snapshot versions from one repository read', async () => {
    const { sut, close, reopenPeriod, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    await close.close(2026, 6);
    await reopenPeriod(2026, 6);
    await close.close(2026, 6);

    const summary = await sut.get(2026, 6);

    expect(summary.snapshotVersion).toBe(2);
    expect(summary.snapshotVersions?.map((entry) => entry.version)).toEqual([
      1, 2,
    ]);
  });

  it('CLOSED month: served VERBATIM from the snapshot — later stamp changes never leak (US6)', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    await close.close(2026, 6);

    // The store changes AFTER the close (late traces, corrections...).
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
      usageRecord({ traceId: 't-late' }),
    ]);

    const summary = await sut.get(2026, 6);

    expect(summary.periodStatus).toBe('closed');
    expect(summary.snapshotVersion).toBe(1);
    expect(summary.statement.stampedTraceCount).toBe(1);
    expect(summary.statement.totalCostMicrocents).toBe(2_500_000_000);
    expect(summary.closedAt).toEqual(NOW);
  });

  it('CLOSED month without its snapshot is corrupt state — throws, never recomputes (T7)', async () => {
    const { sut, billingPeriodRepository } = makeSut();
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

    await expect(sut.get(2026, 6)).rejects.toThrow(/no snapshot/);
  });

  it('US10: comparison against the previous month, total and per agent', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-5', [
      usageRecord({ traceId: 'm1' }),
    ]);
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
      usageRecord({ traceId: 't2', agentId: 'suporte' }),
    ]);

    const summary = await sut.get(2026, 6);

    expect(summary.comparison).not.toBeNull();
    expect(summary.comparison?.previousTotalCostMicrocents).toBe(2_500_000_000);
    expect(summary.comparison?.totalDeltaMicrocents).toBe(2_500_000_000);

    const suporte = summary.comparison?.byAgent.find(
      (agent) => agent.agentId === 'suporte',
    );
    expect(suporte?.previousCostMicrocents).toBe(0);
    expect(suporte?.deltaMicrocents).toBe(2_500_000_000);
  });

  it('comparison is null when neither month has stamped traces', async () => {
    const { sut } = makeSut();

    expect((await sut.get(2026, 6)).comparison).toBeNull();
  });

  it('carries watermark, pending and quarantine visibility (US2/US5)', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.watermarkByMonth.set(
      '2026-6',
      new Date('2026-06-30T23:59:00.000Z'),
    );
    billingQueryRepository.pendingByMonth.set('2026-6', {
      traceCount: 1,
      tokens: { input: 10 },
      models: ['m'],
    });
    billingQueryRepository.quarantinedByMonth.set('2026-6', 2);

    const summary = await sut.get(2026, 6);

    expect(summary.ingestionWatermark).toEqual(
      new Date('2026-06-30T23:59:00.000Z'),
    );
    expect(summary.pendingPrice.traceCount).toBe(1);
    expect(summary.quarantinedTraceCount).toBe(2);
  });

  it('surfaces reopen audit notes with the statement (US5)', async () => {
    const { sut, close, billingQueryRepository, billingPeriodRepository } =
      makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    await close.close(2026, 6);
    await billingPeriodRepository.markReopened({
      year: 2026,
      month: 6,
      audit: {
        at: new Date('2026-07-10T00:00:00.000Z'),
        action: 'reopen',
        trigger: 'runbook',
        reason: 'preço corrigido',
        snapshotVersion: 1,
      },
    });

    const summary = await sut.get(2026, 6);

    expect(summary.periodStatus).toBe('open');
    expect(summary.reopenNotes).toEqual([
      { at: new Date('2026-07-10T00:00:00.000Z'), reason: 'preço corrigido' },
    ]);
  });
});
