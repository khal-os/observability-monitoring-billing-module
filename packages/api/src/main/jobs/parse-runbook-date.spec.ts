import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerPriceVersionRequestSchema } from '../../presentation/controllers/prices/price-view-schemas.js';
import { parseRunbookDate } from './parse-runbook-date.js';

/**
 * The runbook price door (`make price` / `npm run price:insert`) must accept
 * EXACTLY what POST /prices accepts — C-2: the two doors cannot diverge.
 * The job used to parse `--effective-from` with a bare `new Date()`, which
 * happily reads the pt-BR spelling "01/07/2026" as 7 January (US m/d/y) and
 * registers an immutable price for six months nobody contracted.
 */
describe('parseRunbookDate (runbook --effective-from border)', () => {
  /** What the HTTP door does with the same string — the reference answer. */
  const httpDoor = (raw: string): Date | null => {
    const parsed = registerPriceVersionRequestSchema.safeParse({
      model: 'anthropic/claude-opus-4-8',
      token_type: 'input',
      price_brl_per_million: '82.50',
      effective_from: raw,
    });

    return parsed.success ? parsed.data.effective_from : null;
  };

  describe('ACCEPTS the spellings POST /prices accepts', () => {
    it('MUST read a date-only value as UTC midnight', () => {
      expect(parseRunbookDate('2026-07-01')?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('MUST accept a Z-carrying datetime', () => {
      expect(parseRunbookDate('2026-07-01T00:00:00Z')?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('MUST accept an offset-carrying datetime, applying the offset', () => {
      expect(
        parseRunbookDate('2026-07-01T00:00:00+03:00')?.toISOString(),
      ).toBe('2026-06-30T21:00:00.000Z');
    });
  });

  describe('REFUSES everything else — a wrong instant is an immutable stamp (invariant 1)', () => {
    it('MUST refuse a timezone-less local datetime (B-8)', () => {
      expect(parseRunbookDate('2026-07-01T00:00:00')).toBeNull();
    });

    it('MUST refuse the pt-BR/US ambiguous "01/07/2026" instead of reading it as 7 January', () => {
      expect(parseRunbookDate('01/07/2026')).toBeNull();
    });

    it('MUST refuse loose spellings `new Date()` would have swallowed', () => {
      expect(parseRunbookDate('July 1 2026')).toBeNull();
      expect(parseRunbookDate('2026-7-1')).toBeNull();
    });

    it('MUST refuse garbage and calendar-impossible dates', () => {
      expect(parseRunbookDate('not-a-date')).toBeNull();
      expect(parseRunbookDate('')).toBeNull();
      expect(parseRunbookDate('2026-02-30')).toBeNull();
    });
  });

  it('MUST answer exactly like POST /prices for every one of those spellings (C-2)', () => {
    const spellings = [
      '2026-07-01',
      '2026-07-01T00:00:00Z',
      '2026-07-01T00:00:00+03:00',
      '2026-07-01T00:00:00-03:00',
      '2026-07-01T00:00:00',
      '01/07/2026',
      'July 1 2026',
      '2026-7-1',
      '2026-02-30',
      'not-a-date',
      '',
    ];

    const answers = spellings.map((raw) => [
      raw,
      parseRunbookDate(raw)?.toISOString() ?? 'REFUSED',
    ]);
    const reference = spellings.map((raw) => [
      raw,
      httpDoor(raw)?.toISOString() ?? 'REFUSED',
    ]);

    expect(answers).toEqual(reference);
  });

  /**
   * The job itself is a top-level-await script that connects the database on
   * import, so it cannot be exercised in-process. Its ONE line of wiring is
   * pinned here at source level (same technique as architecture-boundaries):
   * putting `new Date(effectiveFromRaw)` back would restore the divergence
   * with every assertion above still green.
   */
  it('MUST be the border insert-price-version.ts actually uses', () => {
    const job = readFileSync(join(__dirname, 'insert-price-version.ts'), 'utf-8');

    expect(job).toContain("from './parse-runbook-date.js'");
    expect(job).toContain('parseRunbookDate(effectiveFromRaw)');
    expect(job).not.toContain('new Date(effectiveFromRaw)');
  });
});

/**
 * The sync door took four more audit iterations to reach: `make sync` kept
 * the bare constructor long after the price door was fixed, and iteration 3
 * even filed it and had it wrongly waved through. The window it feeds is
 * half-open [from, to) into the PERMANENT archive, and it is also the
 * dead-letter recovery door whose runbook then says to delete the row — so
 * a silently-different window loses the trace twice (invariant 6).
 */
describe('parseRunbookDate (runbook --from/--to sync border, decision 123)', () => {
  it('MUST refuse the pt-BR spelling that reads as a valid US date', () => {
    // The whole defect in one line: this is NOT invalid, it is a DIFFERENT
    // day — 7 January, from an operator who wrote "1 July". Asserted on the
    // LOCAL parts because the fallback parser yields local midnight, which
    // is itself part of the problem (the instant moved with the host's TZ);
    // the fix refuses the spelling outright, so neither is our concern.
    const loose = new Date('01/07/2026');

    expect([loose.getFullYear(), loose.getMonth(), loose.getDate()]).toEqual([
      2026, 0, 7,
    ]);
    expect(parseRunbookDate('01/07/2026')).toBeNull();
  });

  it('MUST refuse a spelling that yields a POPULATED but wrong window', () => {
    // The nastier variant: both ends misparse into a real window, so even
    // the "fetched 0" line at the end of the run does not fire.
    expect(parseRunbookDate('06/07/2026')).toBeNull();
    expect(parseRunbookDate('07/07/2026')).toBeNull();
  });

  it('MUST accept the documented window spelling as UTC', () => {
    expect(parseRunbookDate('2026-07-01')?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(parseRunbookDate('2026-08-01')?.toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('MUST refuse a timezone-less datetime (the window would shift per host)', () => {
    expect(parseRunbookDate('2026-07-01T00:00:00')).toBeNull();
  });

  /** Same source-level pin as the price door: run-sync is a top-level-await script. */
  it('MUST be the border run-sync.ts actually uses', () => {
    const job = readFileSync(join(__dirname, 'run-sync.ts'), 'utf-8');

    expect(job).toContain("from './parse-runbook-date.js'");
    expect(job).toContain("parseRunbookDate(values['from'])");
    expect(job).toContain("parseRunbookDate(values['to'])");
    expect(job).not.toContain("new Date(values['from'])");
    expect(job).not.toContain("new Date(values['to'])");
  });
});
