import {
  contentToText,
  formatAgeDisplay,
  formatBrlDisplay,
  formatDateTimeDisplay,
  formatDurationDisplay,
  formatIntDisplay,
  formatMonthLabel,
  formatUtcDateDisplay,
} from './display.js';

describe('display helpers (decision 51 — API owns every displayed value)', () => {
  it('formatIntDisplay MUST group thousands pt-BR style', () => {
    expect(formatIntDisplay(0)).toBe('0');
    expect(formatIntDisplay(999)).toBe('999');
    expect(formatIntDisplay(21038)).toBe('21.038');
    expect(formatIntDisplay(1234567)).toBe('1.234.567');
  });

  it('formatBrlDisplay MUST render decimal strings with comma and R$', () => {
    expect(formatBrlDisplay('0.08')).toBe('R$ 0,08');
    expect(formatBrlDisplay('1234.56')).toBe('R$ 1.234,56');
    // Exact costs keep FULL precision — display formatting never rounds.
    expect(formatBrlDisplay('0.00096525')).toBe('R$ 0,00096525');
  });

  it('formatDurationDisplay MUST use ms below 1s and one-decimal seconds above', () => {
    expect(formatDurationDisplay(0)).toBe('0 ms');
    expect(formatDurationDisplay(731)).toBe('731 ms');
    expect(formatDurationDisplay(1200)).toBe('1,2 s');
    expect(formatDurationDisplay(19800)).toBe('19,8 s');
    expect(formatDurationDisplay(6000)).toBe('6 s');
  });

  it('datetime display MUST use the fixed client timezone UTC-3', () => {
    expect(formatDateTimeDisplay(new Date('2026-07-20T17:51:22.349Z'))).toBe(
      '20/07/2026, 14:51:22',
    );
    // Crossing midnight: 01:30Z on the 21st is 22:30 on the 20th in UTC-3.
    expect(formatDateTimeDisplay(new Date('2026-07-21T01:30:00.000Z'))).toBe(
      '20/07/2026, 22:30:00',
    );
  });

  it('formatUtcDateDisplay MUST render the UTC calendar date (price versions)', () => {
    expect(formatUtcDateDisplay(new Date('2026-07-01T00:00:00.000Z'))).toBe(
      '01/07/2026',
    );
  });

  it('formatAgeDisplay MUST scale agora → min → h → d', () => {
    const now = new Date('2026-07-20T12:00:00.000Z');

    expect(formatAgeDisplay(new Date('2026-07-20T11:59:40.000Z'), now)).toBe('agora');
    expect(formatAgeDisplay(new Date('2026-07-20T11:25:00.000Z'), now)).toBe('há 35 min');
    expect(formatAgeDisplay(new Date('2026-07-20T09:00:00.000Z'), now)).toBe('há 3 h');
    expect(formatAgeDisplay(new Date('2026-07-17T12:00:00.000Z'), now)).toBe('há 3 d');
  });

  it('formatMonthLabel MUST name months in Portuguese', () => {
    expect(formatMonthLabel(2026, 7)).toBe('julho de 2026');
    expect(formatMonthLabel(2026, 3)).toBe('março de 2026');
  });

  it('contentToText MUST pass strings through and pretty-print objects', () => {
    expect(contentToText(null)).toBeNull();
    expect(contentToText(undefined)).toBeNull();
    expect(contentToText('olá')).toBe('olá');
    expect(contentToText({ tool: 'x' })).toBe('{\n  "tool": "x"\n}');
  });
});
