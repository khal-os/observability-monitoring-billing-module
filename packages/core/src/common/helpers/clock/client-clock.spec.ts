import {
  assertValidTimezone,
  clientCalendarOf,
  clientTimezone,
  clientUtcOffsetMs,
  initializeClientClock,
  resetClientClockForTests,
  startOfClientMonth,
} from './client-clock.js';

/**
 * Decision 130 (audit B-4/Q1): billing boundary ≡ display zone ≡ the
 * client's business day, from one required knob. These cases pin the two
 * properties everything downstream leans on: the boundary is the CLIENT
 * midnight (not UTC), and offsets are per-instant (DST zones stay correct
 * on both sides of a transition).
 */
describe('client clock (decision 130)', () => {
  afterEach(() => {
    // The suite-wide jest setup re-initializes for the next spec file;
    // within THIS file each case declares its own zone.
    initializeClientClock('America/Sao_Paulo');
  });

  it('MUST refuse to answer while uninitialized — a fallback zone is a wrong bill', () => {
    resetClientClockForTests();

    expect(() => clientTimezone()).toThrow(/CLIENT_TIMEZONE/);
  });

  it('MUST reject a non-IANA name at initialization', () => {
    expect(() => assertValidTimezone('Sao Paulo')).toThrow(/not a valid IANA/);
    expect(() => initializeClientClock('BRT-3')).toThrow(/not a valid IANA/);
  });

  it('MUST report the São Paulo offset as -3h (no DST since 2019)', () => {
    initializeClientClock('America/Sao_Paulo');

    expect(clientUtcOffsetMs(new Date('2026-01-15T12:00:00Z'))).toBe(
      -3 * 3_600_000,
    );
    expect(clientUtcOffsetMs(new Date('2026-07-15T12:00:00Z'))).toBe(
      -3 * 3_600_000,
    );
  });

  it('MUST start the client month at the CLIENT midnight — the B-4 boundary itself', () => {
    initializeClientClock('America/Sao_Paulo');

    // August in São Paulo begins at 03:00 UTC — the exact three hours
    // whose traces the old UTC boundary billed under the wrong month.
    expect(startOfClientMonth(2026, 8).toISOString()).toBe(
      '2026-08-01T03:00:00.000Z',
    );
  });

  it('MUST place the last local hours of a month INSIDE that month', () => {
    initializeClientClock('America/Sao_Paulo');

    // 2026-08-01T01:00Z is 31/07 22:00 in São Paulo — the audit example.
    expect(clientCalendarOf(new Date('2026-08-01T01:00:00Z'))).toEqual({
      year: 2026,
      month: 7,
    });
  });

  it('MUST be DST-correct — a New York month window uses the offset of EACH boundary', () => {
    initializeClientClock('America/New_York');

    // March begins under EST (UTC-5); April begins under EDT (UTC-4):
    // the two boundaries of one month carry DIFFERENT offsets.
    expect(startOfClientMonth(2026, 3).toISOString()).toBe(
      '2026-03-01T05:00:00.000Z',
    );
    expect(startOfClientMonth(2026, 4).toISOString()).toBe(
      '2026-04-01T04:00:00.000Z',
    );
  });

  it("MUST treat 'UTC' as a first-class zone (offset 0)", () => {
    initializeClientClock('UTC');

    expect(clientUtcOffsetMs(new Date('2026-06-15T00:00:00Z'))).toBe(0);
    expect(startOfClientMonth(2026, 6).toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});
