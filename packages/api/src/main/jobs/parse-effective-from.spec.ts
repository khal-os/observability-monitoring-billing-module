import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerPriceVersionRequestSchema } from '../../presentation/controllers/prices/price-view-schemas.js';
import { parseEffectiveFrom } from './parse-effective-from.js';

/**
 * The runbook price door (`make price` / `npm run price:insert`) must accept
 * EXACTLY what POST /prices accepts — C-2: the two doors cannot diverge.
 * The job used to parse `--effective-from` with a bare `new Date()`, which
 * happily reads the pt-BR spelling "01/07/2026" as 7 January (US m/d/y) and
 * registers an immutable price for six months nobody contracted.
 */
describe('parseEffectiveFrom (runbook --effective-from border)', () => {
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
      expect(parseEffectiveFrom('2026-07-01')?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('MUST accept a Z-carrying datetime', () => {
      expect(parseEffectiveFrom('2026-07-01T00:00:00Z')?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('MUST accept an offset-carrying datetime, applying the offset', () => {
      expect(
        parseEffectiveFrom('2026-07-01T00:00:00+03:00')?.toISOString(),
      ).toBe('2026-06-30T21:00:00.000Z');
    });
  });

  describe('REFUSES everything else — a wrong instant is an immutable stamp (invariant 1)', () => {
    it('MUST refuse a timezone-less local datetime (B-8)', () => {
      expect(parseEffectiveFrom('2026-07-01T00:00:00')).toBeNull();
    });

    it('MUST refuse the pt-BR/US ambiguous "01/07/2026" instead of reading it as 7 January', () => {
      expect(parseEffectiveFrom('01/07/2026')).toBeNull();
    });

    it('MUST refuse loose spellings `new Date()` would have swallowed', () => {
      expect(parseEffectiveFrom('July 1 2026')).toBeNull();
      expect(parseEffectiveFrom('2026-7-1')).toBeNull();
    });

    it('MUST refuse garbage and calendar-impossible dates', () => {
      expect(parseEffectiveFrom('not-a-date')).toBeNull();
      expect(parseEffectiveFrom('')).toBeNull();
      expect(parseEffectiveFrom('2026-02-30')).toBeNull();
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
      parseEffectiveFrom(raw)?.toISOString() ?? 'REFUSED',
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

    expect(job).toContain("from './parse-effective-from.js'");
    expect(job).toContain('parseEffectiveFrom(effectiveFromRaw)');
    expect(job).not.toContain('new Date(effectiveFromRaw)');
  });
});
