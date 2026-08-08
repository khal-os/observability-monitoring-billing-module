import { parseRunbookYearMonth } from './parse-runbook-year-month.js';

describe('parseRunbookYearMonth (audit B-2 — the year/month border of every runbook door)', () => {
  it('MUST accept a real period', () => {
    expect(parseRunbookYearMonth('2026', '6')).toEqual({
      year: 2026,
      month: 6,
    });
    expect(parseRunbookYearMonth('2026', '12')).toEqual({
      year: 2026,
      month: 12,
    });
  });

  it('MUST refuse the two-digit year that closed June 1926', () => {
    expect(parseRunbookYearMonth('26', '6')).toBeNull();
  });

  it('MUST refuse out-of-range months LOUDLY at the border — not as a raw stack downstream', () => {
    expect(parseRunbookYearMonth('2026', '0')).toBeNull();
    expect(parseRunbookYearMonth('2026', '13')).toBeNull();
  });

  it('MUST refuse non-numeric and missing values', () => {
    expect(parseRunbookYearMonth('junho', '6')).toBeNull();
    expect(parseRunbookYearMonth('2026', 'junho')).toBeNull();
    expect(parseRunbookYearMonth(undefined, '6')).toBeNull();
    expect(parseRunbookYearMonth('2026', undefined)).toBeNull();
    expect(parseRunbookYearMonth('2026.0', '6')).toBeNull();
  });
});
