import { CloseDueBillingPeriodsDbUseCase } from './close-due-billing-periods-db-use-case.js';
import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
} from './billing-lifecycle-protocols.js';
import {
  InMemoryBillingPeriodRepository,
  StubBillingQueryRepository,
  usageRecord,
} from '@observability/core/application/testSupport/billing-test-fakes.js';
import { initializeClientClock } from '@observability/core/common/helpers/clock/client-clock.js';

const HOUR_MS = 3_600_000;

const closeResult = (
  year: number,
  month: number,
): CloseBillingPeriodResult => ({
  year,
  month,
  snapshotVersion: 1,
  totalCostMicrocents: 0,
  totalDisplayCents: 0,
  stampedTraceCount: 0,
  ingestionWatermark: null,
  quarantine: { flaggedStragglers: 0, absorbed: 0 },
});

/** Records every attempt; a configured month throws instead of closing. */
class RecordingCloseUseCase implements CloseBillingPeriodUseCase {
  readonly attempts: { year: number; month: number }[] = [];
  readonly failWith = new Map<string, Error>();

  async close(year: number, month: number): Promise<CloseBillingPeriodResult> {
    this.attempts.push({ year, month });

    const failure = this.failWith.get(`${year}-${month}`);

    if (failure) throw failure;

    return closeResult(year, month);
  }
}

const makeSut = (args: { delayMs?: number; now: Date }) => {
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const billingQueryRepository = new StubBillingQueryRepository();
  const closeBillingPeriod = new RecordingCloseUseCase();

  const sut = new CloseDueBillingPeriodsDbUseCase({
    billingPeriodRepository,
    billingQueryRepository,
    closeBillingPeriod,
    delayMs: args.delayMs ?? HOUR_MS,
    now: () => args.now,
  });

  return {
    sut,
    billingPeriodRepository,
    billingQueryRepository,
    closeBillingPeriod,
  };
};

/** Seeds one stamped trace so the month "has traces" for the walk. */
const seedMonth = (
  repository: StubBillingQueryRepository,
  year: number,
  month: number,
  startedAt: string,
): void => {
  repository.usageByMonth.set(`${year}-${month}`, [
    usageRecord({
      traceId: `t-${year}-${month}`,
      startedAt: new Date(startedAt),
    }),
  ]);
};

describe('CloseDueBillingPeriodsDbUseCase (decision 131 — the reconcile walk)', () => {
  afterEach(() => {
    // The suite-wide jest setup re-initializes for the next spec file;
    // within THIS file the DST cases declare their own zone.
    initializeClientClock('America/Sao_Paulo');
  });

  describe('eligibility = client month end + delay', () => {
    // America/Sao_Paulo (UTC-3, no DST): June 2026 ends 2026-07-01T03:00Z;
    // with a 60min delay the month becomes due at exactly 04:00Z.
    it('MUST NOT attempt a month one instant before end + delay', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: new Date('2026-07-01T03:59:59.999Z'),
      });
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([]);
      expect(report.closed).toEqual([]);
      expect(report.nextCandidate).toEqual({
        year: 2026,
        month: 6,
        eligibleAt: new Date('2026-07-01T04:00:00.000Z'),
      });
    });

    it('MUST close the month at exactly end + delay', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: new Date('2026-07-01T04:00:00.000Z'),
      });
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([{ year: 2026, month: 6 }]);
      expect(report.closed).toHaveLength(1);
    });

    it('handles a leap February at the client boundary', async () => {
      // Feb 2028 (leap) ends 2028-03-01T03:00Z in São Paulo → due 04:00Z.
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: new Date('2028-03-01T04:00:00.000Z'),
      });
      seedMonth(billingQueryRepository, 2028, 2, '2028-02-29T12:00:00.000Z');

      await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([{ year: 2028, month: 2 }]);
    });
  });

  describe('DST zones (decision 130 — the boundary is the client midnight)', () => {
    it('a month ending under DST becomes due at the SHIFTED instant (America/New_York, March)', async () => {
      initializeClientClock('America/New_York');
      // March 2026 ends Apr 1 00:00 EDT (UTC-4) = 04:00Z → due 05:00Z.
      const early = makeSut({ now: new Date('2026-04-01T04:59:59.999Z') });
      seedMonth(
        early.billingQueryRepository,
        2026,
        3,
        '2026-03-15T12:00:00.000Z',
      );

      await early.sut.runCycle();

      expect(early.closeBillingPeriod.attempts).toEqual([]);

      const due = makeSut({ now: new Date('2026-04-01T05:00:00.000Z') });
      seedMonth(
        due.billingQueryRepository,
        2026,
        3,
        '2026-03-15T12:00:00.000Z',
      );

      await due.sut.runCycle();

      expect(due.closeBillingPeriod.attempts).toEqual([
        { year: 2026, month: 3 },
      ]);
    });

    it('a month ending after DST falls back becomes due at the LATER offset (America/New_York, November)', async () => {
      initializeClientClock('America/New_York');
      // November 2026 ends Dec 1 00:00 EST (UTC-5) = 05:00Z → due 06:00Z.
      const early = makeSut({ now: new Date('2026-12-01T05:59:59.999Z') });
      seedMonth(
        early.billingQueryRepository,
        2026,
        11,
        '2026-11-15T12:00:00.000Z',
      );

      await early.sut.runCycle();

      expect(early.closeBillingPeriod.attempts).toEqual([]);

      const due = makeSut({ now: new Date('2026-12-01T06:00:00.000Z') });
      seedMonth(
        due.billingQueryRepository,
        2026,
        11,
        '2026-11-15T12:00:00.000Z',
      );

      await due.sut.runCycle();

      expect(due.closeBillingPeriod.attempts).toEqual([
        { year: 2026, month: 11 },
      ]);
    });
  });

  describe('the walk (oldest first, one wake)', () => {
    const NOW = new Date('2026-07-15T10:00:00.000Z');

    it('MUST catch up several overdue months oldest-first in one cycle (scheduler downtime)', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: NOW,
      });
      seedMonth(billingQueryRepository, 2026, 4, '2026-04-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 5, '2026-05-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([
        { year: 2026, month: 4 },
        { year: 2026, month: 5 },
        { year: 2026, month: 6 },
      ]);
      expect(report.closed).toHaveLength(3);
      // The walk stopped at the in-progress month, never attempting it.
      expect(report.nextCandidate?.year).toBe(2026);
      expect(report.nextCandidate?.month).toBe(7);
    });

    it('MUST skip a trace-free gap month without attempting it (the close-order guard exemption)', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: NOW,
      });
      seedMonth(billingQueryRepository, 2026, 4, '2026-04-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');

      await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([
        { year: 2026, month: 4 },
        { year: 2026, month: 6 },
      ]);
    });

    it('MUST skip already-closed months (pre-check, not error-driven)', async () => {
      const {
        sut,
        billingQueryRepository,
        billingPeriodRepository,
        closeBillingPeriod,
      } = makeSut({ now: NOW });
      seedMonth(billingQueryRepository, 2026, 5, '2026-05-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');
      await billingPeriodRepository.markClosed({
        year: 2026,
        month: 5,
        closedAt: new Date('2026-06-01T04:00:00.000Z'),
        snapshotVersion: 1,
        audit: {
          at: new Date('2026-06-01T04:00:00.000Z'),
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });

      await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([{ year: 2026, month: 6 }]);
    });

    it('MUST hold on a REOPENED month and stop the walk — the correction flow owns it', async () => {
      const {
        sut,
        billingQueryRepository,
        billingPeriodRepository,
        closeBillingPeriod,
      } = makeSut({ now: NOW });
      seedMonth(billingQueryRepository, 2026, 5, '2026-05-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');
      // A period doc with status 'open' exists only via an audited reopen.
      billingPeriodRepository.periods.set('2026-5', {
        year: 2026,
        month: 5,
        status: 'open',
        audit: [],
      });

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([]);
      expect(report.reopenedHold).toEqual({ year: 2026, month: 5 });
      // June is due and has traces, but the hold stops everything newer.
      expect(report.closed).toEqual([]);
    });

    it('MUST report a blocked month with its models, stop the walk, and leave the retry to the next cycle', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: NOW,
      });
      seedMonth(billingQueryRepository, 2026, 5, '2026-05-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');
      closeBillingPeriod.failWith.set(
        '2026-5',
        new BillingCloseBlockedError({
          pendingTraceCount: 3,
          modelsWithoutPrice: ['meta/llama-4-scout'],
        }),
      );

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([{ year: 2026, month: 5 }]);
      expect(report.blocked).toMatchObject({
        year: 2026,
        month: 5,
        pendingTraceCount: 3,
        modelsWithoutPrice: ['meta/llama-4-scout'],
      });
      expect(report.closed).toEqual([]);
    });

    it('MUST treat losing the race to a concurrent runbook close as benign and keep walking', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: NOW,
      });
      seedMonth(billingQueryRepository, 2026, 5, '2026-05-10T12:00:00.000Z');
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');
      closeBillingPeriod.failWith.set(
        '2026-5',
        new BillingPeriodStateError(
          'O mês 2026-05 já está fechado (snapshot v1).',
        ),
      );

      const report = await sut.runCycle();

      expect(report.racedAlreadyClosed).toEqual([{ year: 2026, month: 5 }]);
      expect(closeBillingPeriod.attempts).toEqual([
        { year: 2026, month: 5 },
        { year: 2026, month: 6 },
      ]);
      expect(report.closed).toHaveLength(1);
    });

    it('MUST propagate an unexpected error to the loop (backoff territory)', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: NOW,
      });
      seedMonth(billingQueryRepository, 2026, 6, '2026-06-10T12:00:00.000Z');
      closeBillingPeriod.failWith.set('2026-6', new Error('mongo down'));

      await expect(sut.runCycle()).rejects.toThrow('mongo down');
    });
  });

  describe('nothing to do', () => {
    it('an empty store reports waiting with no candidate and no attempts', async () => {
      const { sut, closeBillingPeriod } = makeSut({
        now: new Date('2026-07-15T10:00:00.000Z'),
      });

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([]);
      expect(report).toEqual({ closed: [], racedAlreadyClosed: [] });
    });

    it('MUST never attempt the current (in-progress) month', async () => {
      const { sut, billingQueryRepository, closeBillingPeriod } = makeSut({
        now: new Date('2026-07-15T10:00:00.000Z'),
      });
      seedMonth(billingQueryRepository, 2026, 7, '2026-07-10T12:00:00.000Z');

      const report = await sut.runCycle();

      expect(closeBillingPeriod.attempts).toEqual([]);
      expect(report.nextCandidate?.month).toBe(7);
    });
  });
});
