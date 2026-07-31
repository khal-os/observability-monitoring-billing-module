import {
  GetBillingSummaryDbUseCase,
  monthWindowUtc,
  previousMonthOf,
} from './get-billing-summary-db-use-case.js';
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
    now: () => now,
  });

  return {
    sut,
    close,
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
