import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunbookDate } from '@khal/core/common/helpers/parse-runbook-date.js';
import { registerPriceVersionRequestSchema } from '../../presentation/controllers/prices/price-view-schemas.js';

/**
 * Decision 123's module half: the runbook price door and POST /prices are
 * the SAME border. Behavior of the parser is specced next to it in
 * @khal/core; what belongs HERE is (a) the cross-door equivalence against
 * this package's real HTTP schema and (b) the source-level pin of the job's
 * one line of wiring — the job is a top-level-await script that connects
 * the database on import, so it cannot be exercised in-process (same
 * technique as architecture-boundaries).
 */
describe('runbook date wiring (decision 123, price door)', () => {
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

  it('MUST answer exactly like POST /prices for every spelling (C-2)', () => {
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

  it('MUST be the border insert-price-version.ts actually uses', () => {
    const job = readFileSync(join(__dirname, 'insert-price-version.ts'), 'utf-8');

    expect(job).toContain(
      "from '@khal/core/common/helpers/parse-runbook-date.js'",
    );
    expect(job).toContain('parseRunbookDate(effectiveFromRaw)');
    expect(job).not.toContain('new Date(effectiveFromRaw)');
  });

  it('MUST keep effective_from on the ONE shared rule (isoDateRule)', () => {
    // The equivalence above holds because both doors consume the same zod
    // schema from core. This pin makes re-spelling the union here a red
    // test, not a silent fork.
    const schemas = readFileSync(
      join(
        __dirname,
        '../../presentation/controllers/prices/price-view-schemas.ts',
      ),
      'utf-8',
    );

    expect(schemas).toContain('effective_from: isoDateRule');
  });
});
