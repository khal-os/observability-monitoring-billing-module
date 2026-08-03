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
