import {
  BillingPeriodModel,
  firstOpenMonthStart,
  monthWindowUtc,
  previousMonthOf,
  resolvePeriodStatus,
} from './billing-period-model.js';

const period = (
  year: number,
  month: number,
  status: 'open' | 'closed',
): BillingPeriodModel => ({ year, month, status, audit: [] });

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

describe('resolvePeriodStatus() (invariant 8 label rule, stated once)', () => {
  const NOW = new Date('2026-07-19T12:00:00.000Z');

  it('a lifecycle-closed month is closed regardless of the calendar', () => {
    expect(resolvePeriodStatus(2026, 6, period(2026, 6, 'closed'), NOW)).toBe(
      'closed',
    );
    // Even the current month, if somehow closed, reports closed.
    expect(resolvePeriodStatus(2026, 7, period(2026, 7, 'closed'), NOW)).toBe(
      'closed',
    );
  });

  it('the current UTC calendar month is in_progress (always partial)', () => {
    expect(resolvePeriodStatus(2026, 7, null, NOW)).toBe('in_progress');
    expect(resolvePeriodStatus(2026, 7, undefined, NOW)).toBe('in_progress');
  });

  it('any other non-closed month is open — period doc absent or reopened', () => {
    expect(resolvePeriodStatus(2026, 6, null, NOW)).toBe('open');
    expect(resolvePeriodStatus(2026, 6, period(2026, 6, 'open'), NOW)).toBe(
      'open',
    );
    // Same calendar month of ANOTHER year is not in_progress.
    expect(resolvePeriodStatus(2025, 7, null, NOW)).toBe('open');
  });

  it('resolves the current month against UTC, not local time', () => {
    // One minute before the UTC month turns: still the old month.
    const edge = new Date('2026-07-31T23:59:00.000Z');
    expect(resolvePeriodStatus(2026, 7, null, edge)).toBe('in_progress');
    expect(resolvePeriodStatus(2026, 8, null, edge)).toBe('open');
  });
});

describe('firstOpenMonthStart() (audit C-7.1)', () => {
  it('is null while no month ever closed (unbounded scan — PoC behavior)', () => {
    expect(firstOpenMonthStart([], null)).toBeNull();
    expect(firstOpenMonthStart([period(2026, 6, 'open')], null)).toBeNull();
    // Data older than everything cannot bound what is already unbounded.
    expect(
      firstOpenMonthStart([], new Date('2019-03-04T05:06:07.000Z')),
    ).toBeNull();
  });

  it('is the month after a contiguous closed run', () => {
    expect(
      firstOpenMonthStart(
        [period(2026, 5, 'closed'), period(2026, 6, 'closed')],
        new Date('2026-05-02T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('crosses the year boundary', () => {
    expect(
      firstOpenMonthStart(
        [period(2026, 12, 'closed')],
        new Date('2026-12-09T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('a REOPENED (or skipped) month inside the run pulls the bound back — its live data must be scanned', () => {
    expect(
      firstOpenMonthStart(
        [
          period(2026, 4, 'closed'),
          period(2026, 5, 'open'), // reopened
          period(2026, 6, 'closed'),
        ],
        new Date('2026-04-03T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
  });

  it('re-audit: reopening the EARLIEST closed month pulls the bound back to it', () => {
    // The forward walk anchors on the earliest STILL-closed month (June),
    // which would put the bound at 2026-07-01 and drop reopened May out of
    // /bills and the monthly series while /billing/summary still bills it.
    expect(
      firstOpenMonthStart(
        [
          period(2026, 5, 'open'), // reopened, and the oldest month there is
          period(2026, 6, 'closed'),
        ],
        new Date('2026-05-10T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
  });

  it('re-audit: a reopened month crossing the year boundary still bounds the scan', () => {
    expect(
      firstOpenMonthStart(
        [
          period(2025, 12, 'open'), // reopened
          period(2026, 1, 'closed'),
          period(2026, 2, 'closed'),
        ],
        new Date('2025-12-15T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2025-12-01T00:00:00.000Z'));
  });

  it('a reopened month AFTER the closed run never pushes the bound forward', () => {
    // April closed, May never closed (no doc), June closed then reopened:
    // the walk (May) still wins over the reopened June.
    expect(
      firstOpenMonthStart(
        [period(2026, 4, 'closed'), period(2026, 6, 'open')],
        new Date('2026-04-01T00:00:00.000Z'),
      ),
    ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
  });

  /**
   * The THIRD variant of one root defect (re-audit iteration 3): a month
   * that no lifecycle action ever touched owns NO period document, so
   * neither the forward walk's old anchor (the earliest CLOSED month) nor
   * the reopened-document half could see it. Only the data can.
   */
  describe('re-audit iteration 3: the anchor is the DATA, not the earliest closed month', () => {
    it('a trace in a NEVER-closed month older than the earliest closed one pulls the bound onto it', () => {
      expect(
        firstOpenMonthStart(
          [period(2026, 6, 'closed')],
          new Date('2026-05-20T00:00:00.000Z'),
        ),
      ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    });

    it('the pre-history month keeps the bound even across the year boundary and a long closed run', () => {
      expect(
        firstOpenMonthStart(
          [
            period(2026, 1, 'closed'),
            period(2026, 2, 'closed'),
            period(2026, 3, 'closed'),
          ],
          new Date('2025-11-30T23:59:59.000Z'),
        ),
      ).toEqual(new Date('2025-11-01T00:00:00.000Z'));
    });

    it('the walk still runs FROM the data anchor: closed pre-history advances, the first open month stops it', () => {
      // Data starts in March; March and April are closed, May never was.
      expect(
        firstOpenMonthStart(
          [
            period(2026, 3, 'closed'),
            period(2026, 4, 'closed'),
            period(2026, 6, 'closed'),
          ],
          new Date('2026-03-02T00:00:00.000Z'),
        ),
      ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
    });

    it('data INSIDE the earliest closed month never moves the bound backwards', () => {
      // The normal deployment: the earliest trace is in the earliest
      // closed month, so the anchor is unchanged and closed history stays
      // out of the live scan (the whole point of C-7.1).
      expect(
        firstOpenMonthStart(
          [period(2026, 5, 'closed'), period(2026, 6, 'closed')],
          new Date('2026-05-01T00:00:01.000Z'),
        ),
      ).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('an empty store falls back to the lifecycle documents (both halves intact)', () => {
      expect(
        firstOpenMonthStart(
          [period(2026, 5, 'open'), period(2026, 6, 'closed')],
          null,
        ),
      ).toEqual(new Date('2026-05-01T00:00:00.000Z'));
      expect(
        firstOpenMonthStart([period(2026, 6, 'closed')], null),
      ).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    /**
     * The property the readers depend on, asserted directly over every
     * lifecycle shape the three variants take: no non-closed month holding
     * a trace may start before the bound. A future refactor that reopens
     * ANY of the three fails here, not only in the shape it broke.
     */
    it('property: the bound never sits after a non-closed month that holds traces', () => {
      const cases: {
        name: string;
        periods: BillingPeriodModel[];
        traceMonths: { year: number; month: number }[];
      }[] = [
        {
          name: 'variant 1 — never-closed month INSIDE the closed run',
          periods: [period(2026, 4, 'closed'), period(2026, 6, 'closed')],
          traceMonths: [
            { year: 2026, month: 4 },
            { year: 2026, month: 5 },
            { year: 2026, month: 6 },
          ],
        },
        {
          name: 'variant 2 — the EARLIEST closed month reopened',
          periods: [period(2026, 5, 'open'), period(2026, 6, 'closed')],
          traceMonths: [
            { year: 2026, month: 5 },
            { year: 2026, month: 6 },
          ],
        },
        {
          name: 'variant 3 — never-closed month BEFORE the earliest closed one',
          periods: [period(2026, 6, 'closed'), period(2026, 7, 'closed')],
          traceMonths: [
            { year: 2026, month: 5 },
            { year: 2026, month: 6 },
          ],
        },
        {
          name: 'variants 2+3 together, across the year boundary',
          periods: [period(2026, 1, 'open'), period(2026, 2, 'closed')],
          traceMonths: [
            { year: 2025, month: 11 },
            { year: 2026, month: 1 },
          ],
        },
      ];

      for (const testCase of cases) {
        const earliest = testCase.traceMonths
          .map(({ year, month }) => Date.UTC(year, month - 1, 3))
          .sort((a, b) => a - b)[0] as number;
        const bound = firstOpenMonthStart(
          testCase.periods,
          new Date(earliest),
        );
        const closedKeys = new Set(
          testCase.periods
            .filter((candidate) => candidate.status === 'closed')
            .map((candidate) => `${candidate.year}-${candidate.month}`),
        );

        for (const { year, month } of testCase.traceMonths) {
          if (closedKeys.has(`${year}-${month}`)) continue;

          expect({
            case: testCase.name,
            month: `${year}-${month}`,
            covered:
              bound === null ||
              Date.UTC(year, month - 1, 1) >= bound.getTime(),
          }).toEqual({
            case: testCase.name,
            month: `${year}-${month}`,
            covered: true,
          });
        }
      }
    });
  });
});
