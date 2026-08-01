import { GetBillingSeriesDbUseCase } from './get-billing-series-db-use-case.js';
import { GetBillingProjectionDbUseCase } from './get-billing-projection-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../billingLifecycle/close-billing-period-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from '../billingLifecycle/reopen-billing-period-db-use-case.js';
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

  const sut = new GetBillingSeriesDbUseCase({
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

  const reopen = new ReopenBillingPeriodDbUseCase({
    billingPeriodRepository,
    now: () => now,
  });

  return {
    sut,
    close,
    reopen,
    billingQueryRepository,
    billingSnapshotRepository,
  };
};

describe('GetBillingSeriesDbUseCase (T8)', () => {
  it('one total per month: open months live, current labeled in_progress, chronological', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.rollupRows = [
      {
        year: 2026,
        month: 6,
        totalCostMicrocents: 100,
        byTokenType: [{ tokenType: 'input' as const, costMicrocents: 100 }],
        byAgent: [
          {
            agentId: 'a',
            costMicrocents: 100,
            byTokenType: [{ tokenType: 'input' as const, costMicrocents: 100 }],
          },
        ],
        byModel: [
          {
            model: 'm',
            costMicrocents: 100,
            byTokenType: [{ tokenType: 'input' as const, costMicrocents: 100 }],
          },
        ],
      },
      {
        year: 2026,
        month: 7,
        totalCostMicrocents: 40,
        byTokenType: [{ tokenType: 'output' as const, costMicrocents: 40 }],
        byAgent: [
          {
            agentId: 'a',
            costMicrocents: 40,
            byTokenType: [{ tokenType: 'output' as const, costMicrocents: 40 }],
          },
        ],
        byModel: [
          {
            model: 'm',
            costMicrocents: 40,
            byTokenType: [{ tokenType: 'output' as const, costMicrocents: 40 }],
          },
        ],
      },
    ];

    const months = await sut.list(12);

    expect(months.map((month) => [month.month, month.periodStatus])).toEqual([
      [6, 'open'],
      [7, 'in_progress'],
    ]);
  });

  it('a CLOSED month charts its SNAPSHOT total — live drift never leaks (US11)', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
      usageRecord({ traceId: 't2', agentId: 'suporte', agentVersion: '2' }),
    ]);
    await close.close(2026, 6);

    // Live rollup says something else — the snapshot must win.
    billingQueryRepository.rollupRows = [
      {
        year: 2026,
        month: 6,
        totalCostMicrocents: 999,
        byTokenType: [],
        byAgent: [],
        byModel: [],
      },
    ];

    const months = await sut.list(12);

    expect(months[0]?.periodStatus).toBe('closed');
    expect(months[0]?.totalCostMicrocents).toBe(5_000_000_000);
    // Snapshot agents (id, version) merge into the series' id dimension;
    // token splits are sums of the FROZEN per-type numbers.
    expect(months[0]?.byAgent).toEqual([
      {
        agentId: 'eugenia',
        costMicrocents: 2_500_000_000,
        byTokenType: [{ tokenType: 'input', costMicrocents: 2_500_000_000 }],
      },
      {
        agentId: 'suporte',
        costMicrocents: 2_500_000_000,
        byTokenType: [{ tokenType: 'input', costMicrocents: 2_500_000_000 }],
      },
    ]);
    expect(months[0]?.byTokenType).toEqual([
      { tokenType: 'input', costMicrocents: 5_000_000_000 },
    ]);
  });

  it('a month with zero traffic materializes as a zero bar — a gap must LOOK like a gap', async () => {
    const { sut, billingQueryRepository } = makeSut();
    // Data in May and July (current) — June has zero traces and no
    // lifecycle doc. It must still chart, as zero, instead of vanishing.
    billingQueryRepository.rollupRows = [5, 7].map((month) => ({
      year: 2026,
      month,
      totalCostMicrocents: month * 100,
      byTokenType: [],
      byAgent: [],
      byModel: [],
    }));

    const months = await sut.list(12);

    expect(
      months.map((month) => [
        month.month,
        month.totalCostMicrocents,
        month.periodStatus,
      ]),
    ).toEqual([
      [5, 500, 'open'],
      [6, 0, 'open'], // empty middle month: zero bar, never a hole
      [7, 700, 'in_progress'],
    ]);
    expect(months[1]?.byTokenType).toEqual([]);
    expect(months[1]?.byAgent).toEqual([]);
    expect(months[1]?.byModel).toEqual([]);
  });

  it('caps at maxMonths, keeping the most recent (current month always present, zero-filled if quiet)', async () => {
    const { sut, billingQueryRepository } = makeSut();
    billingQueryRepository.rollupRows = [3, 4, 5, 6].map((month) => ({
      year: 2026,
      month,
      totalCostMicrocents: month,
      byTokenType: [],
      byAgent: [],
      byModel: [],
    }));

    const months = await sut.list(2);

    expect(
      months.map((month) => [month.month, month.totalCostMicrocents]),
    ).toEqual([
      [6, 6],
      [7, 0], // current month (July) zero-fills into the window
    ]);
  });

  it('applies the maxMonths cap BEFORE snapshot lookups — months outside the window cost zero queries', async () => {
    const { sut, close, billingQueryRepository, billingSnapshotRepository } =
      makeSut();

    // Four closed months (March–June); only June fits the 2-month window
    // (July is the current month) — exactly ONE snapshot lookup allowed.
    for (const month of [3, 4, 5, 6]) {
      billingQueryRepository.usageByMonth.set(`2026-${month}`, [
        usageRecord({ traceId: `t${month}` }),
      ]);
      await close.close(2026, month);
    }

    const findCurrent = jest.spyOn(billingSnapshotRepository, 'findCurrent');

    const months = await sut.list(2);

    expect(months.map((month) => [month.month, month.periodStatus])).toEqual([
      [6, 'closed'],
      [7, 'in_progress'],
    ]);
    expect(findCurrent).toHaveBeenCalledTimes(1);
    expect(findCurrent).toHaveBeenCalledWith(2026, 6);
  });

  it('re-audit: a REOPENED EARLIEST month charts its LIVE cost, never a R$ 0,00 bar', async () => {
    const { sut, close, reopen, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-5', [
      usageRecord({
        traceId: 'may-1',
        startedAt: new Date('2026-05-10T12:00:00.000Z'),
      }),
    ]);
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 'jun-1' }),
    ]);

    await close.close(2026, 5);
    await close.close(2026, 6);
    // The C-7.1 bound used to walk forward from the earliest STILL closed
    // month (June), leaving reopened May behind the rollup's scan: the bar
    // charted R$ 0,00 while /billing/summary billed the month in full.
    await reopen.reopen(2026, 5, 'corrigir atribuição de maio');

    billingQueryRepository.rollupRows = [
      {
        year: 2026,
        month: 5,
        totalCostMicrocents: 9_999_000_000,
        byTokenType: [
          { tokenType: 'input' as const, costMicrocents: 9_999_000_000 },
        ],
        byAgent: [],
        byModel: [],
      },
    ];

    const months = await sut.list(12);
    const may = months.find((month) => month.month === 5);

    expect(may?.periodStatus).toBe('open');
    expect(may?.totalCostMicrocents).toBe(9_999_000_000);
    expect(may?.byTokenType).toEqual([
      { tokenType: 'input', costMicrocents: 9_999_000_000 },
    ]);
    // June stays frozen at its snapshot total.
    expect(
      months.find((month) => month.month === 6)?.totalCostMicrocents,
    ).toBe(2_500_000_000);
  });

  it('re-audit iteration 3: a NEVER-closed month that gains traces after a newer close CHARTS — not even a zero bar existed before', async () => {
    const { sut, close, billingQueryRepository } = makeSut();

    // June closes with an empty May (the close-order guard passes on a
    // trace-free month), then a backfill lands one May trace. May owns no
    // period document, so the reopened-document half of the bound is blind
    // to it and the old walk anchored past it: the month was absent from
    // the chart entirely — not charted as R$ 0,00, simply not emitted.
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 'jun-1' }),
    ]);
    await close.close(2026, 6);

    // The series' only live source is the rollup — May's traces exist in
    // the store precisely because it answers a row for them.
    billingQueryRepository.rollupRows = [
      {
        year: 2026,
        month: 5,
        totalCostMicrocents: 10_000_000_000,
        byTokenType: [
          { tokenType: 'input' as const, costMicrocents: 10_000_000_000 },
        ],
        byAgent: [],
        byModel: [],
      },
    ];

    const months = await sut.list(12);
    const may = months.find((month) => month.month === 5);

    expect(months.map((month) => [month.month, month.periodStatus])).toEqual([
      [5, 'open'],
      [6, 'closed'],
      [7, 'in_progress'],
    ]);
    expect(may?.totalCostMicrocents).toBe(10_000_000_000);
    expect(may?.byTokenType).toEqual([
      { tokenType: 'input', costMicrocents: 10_000_000_000 },
    ]);
    // June stays frozen at its snapshot total.
    expect(months.find((month) => month.month === 6)?.totalCostMicrocents).toBe(
      2_500_000_000,
    );
  });

  it('an empty store charts nothing', async () => {
    const { sut } = makeSut();

    expect(await sut.list(12)).toEqual([]);
  });
});

describe('GetBillingSeriesDbUseCase.listDaily (decision 97)', () => {
  it('returns the last N UTC days ending TODAY, empty days as zero bars, today partial', async () => {
    const { sut, billingQueryRepository } = makeSut();
    // NOW is 2026-07-19T12:00Z → the 3-day window is 17, 18 and 19/07.
    billingQueryRepository.dailyRows = [
      {
        date: new Date('2026-07-17T00:00:00.000Z'),
        totalCostMicrocents: 300,
        byTokenType: [
          { tokenType: 'input', costMicrocents: 200 },
          { tokenType: 'output', costMicrocents: 100 },
        ],
      },
      {
        date: new Date('2026-07-19T00:00:00.000Z'),
        totalCostMicrocents: 50,
        byTokenType: [{ tokenType: 'input', costMicrocents: 50 }],
      },
      // Outside the window — must not leak in.
      {
        date: new Date('2026-07-10T00:00:00.000Z'),
        totalCostMicrocents: 999,
        byTokenType: [],
      },
    ];

    const days = await sut.listDaily(3);

    expect(days.map((day) => [day.date.getUTCDate(), day.totalCostMicrocents, day.partial])).toEqual([
      [17, 300, false],
      [18, 0, false], // gap day materializes as zero — a gap must LOOK like a gap
      [19, 50, true], // today: always partial
    ]);
    expect(days[0]?.byTokenType).toEqual([
      { tokenType: 'input', costMicrocents: 200 },
      { tokenType: 'output', costMicrocents: 100 },
    ]);
  });

  it('labels days of a closed month closed', async () => {
    const { sut, close, billingQueryRepository } = makeSut();
    billingQueryRepository.usageByMonth.set('2026-6', [
      usageRecord({ traceId: 't1' }),
    ]);
    await close.close(2026, 6);

    // 30-day window from 2026-07-19 reaches back into closed June.
    const days = await sut.listDaily(30);

    const juneDay = days.find((day) => day.date.getUTCMonth() === 5);
    const julyDay = days.find((day) => day.date.getUTCMonth() === 6);
    expect(juneDay?.periodStatus).toBe('closed');
    expect(julyDay?.periodStatus).toBe('in_progress');
  });
});

describe('GetBillingProjectionDbUseCase (US12)', () => {
  const makeProjection = (now: Date, accrued: number) => {
    const billingQueryRepository = new StubBillingQueryRepository();
    billingQueryRepository.accrued = accrued;

    return {
      sut: new GetBillingProjectionDbUseCase({
        billingQueryRepository,
        now: () => now,
      }),
      billingQueryRepository,
    };
  };

  it('linear run-rate: accrued ÷ complete days × days in month, half-up', async () => {
    // July 19th → 18 complete days; 31-day month.
    const { sut } = makeProjection(new Date('2026-07-19T12:00:00.000Z'), 1_800);

    const projection = await sut.get();

    expect(projection.completeDays).toBe(18);
    expect(projection.daysInMonth).toBe(31);
    expect(projection.projectedCostMicrocents).toBe(3_100); // 1800/18*31
    expect(projection.insufficientData).toBe(false);
  });

  it('numerator covers COMPLETE days only (start of month → start of today, UTC)', async () => {
    const now = new Date('2026-07-19T15:30:00.000Z');
    const { sut, billingQueryRepository } = makeProjection(now, 0);
    const spy = jest.spyOn(billingQueryRepository, 'accruedCostMicrocents');

    await sut.get();

    expect(spy).toHaveBeenCalledWith(
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-19T00:00:00.000Z'),
    );
  });

  it('under 3 complete days: insufficient — no number is invented (US12)', async () => {
    const { sut } = makeProjection(new Date('2026-07-03T09:00:00.000Z'), 500);

    const projection = await sut.get();

    expect(projection.completeDays).toBe(2);
    expect(projection.insufficientData).toBe(true);
    expect(projection.projectedCostMicrocents).toBeNull();
  });
});
