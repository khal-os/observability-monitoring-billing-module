import { GetBillingSummaryDbUseCase } from './get-billing-summary-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import { BillingPeriodStateError } from '@khal/core/domain/useCases/close-billing-period-use-case.js';
import {
  InMemoryBillingPeriodRepository,
  InMemoryBillingSnapshotRepository,
  QuarantineReconcilerStub,
  StubBillingQueryRepository,
  usageRecord,
} from '@khal/core/application/testSupport/billing-test-fakes.js';

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

// The calendar helpers (monthWindowUtc, previousMonthOf, firstOpenMonthStart)
// and the period-status rule are covered where they live:
// domain/models/billing-period-model.spec.ts.

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

  /**
   * re-audit iteration 6: the comparison keyed agents by joining on a SPACE,
   * so an agent literally named ' ' collided with unattributed traffic and
   * one of the two rows was overwritten out of the panel — while the
   * statement above it still counted both. An agentId of ' ' survives the
   * boundary (the source schema is `min(1)`, the mappers only check
   * `length > 0`), so this is reachable, not theoretical.
   */
  it('MUST NOT merge a whitespace-named agent with unattributed traffic', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-5', [
      usageRecord({ traceId: 'm1' }),
    ]);
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1', agentId: null }),
      usageRecord({ traceId: 't2', agentId: ' ' }),
    ]);

    const summary = await sut.get(2026, 6);
    const rows = summary.comparison?.byAgent ?? [];

    // Three distinct agents across the two months: unattributed and the
    // whitespace-named one this month, eugenia last month. Joining on a
    // space collapses the first two into one row.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.agentId === null)).toHaveLength(1);
    expect(rows.filter((row) => row.agentId === ' ')).toHaveLength(1);

    // The rows must also still reconcile with the delta shown above them.
    const summed = rows.reduce((total, row) => total + row.deltaMicrocents, 0);

    expect(summed).toBe(summary.comparison?.totalDeltaMicrocents);
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

  it('re-audit: the unresolved-quarantine exemption on pending is the CLOSED-month lens only', async () => {
    const { sut, close, reopenPeriod, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);

    await close.close(2026, 6);

    // A June straggler arrives after the close: quarantined, and pending
    // because its model has no registered price.
    billingQueryRepository.quarantinedPendingByMonth.set('2026-6', {
      traceCount: 1,
      tokens: { input: 500_000 },
      models: ['openai/gpt-9'],
    });

    // CLOSED: outside the frozen bill (decision 100) — countQuarantined
    // carries it, the pending panel does not.
    expect((await sut.get(2026, 6)).pendingPrice.traceCount).toBe(0);

    await reopenPeriod(2026, 6);

    // REOPENED: the month is served LIVE, so the straggler is an OPEN cost
    // of the very statement above — the same number the close guard blocks
    // on (decision 113's scope, applied to the pending question).
    const reopened = await sut.get(2026, 6);

    expect(reopened.periodStatus).toBe('open');
    expect(reopened.pendingPrice.traceCount).toBe(1);
    expect(reopened.pendingPrice.models).toEqual(['openai/gpt-9']);
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
