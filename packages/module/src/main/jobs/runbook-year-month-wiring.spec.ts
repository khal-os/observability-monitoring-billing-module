import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Audit B-2's module half: both billing lifecycle jobs are top-level-await
 * scripts (they connect the database on import), so the wiring is pinned at
 * SOURCE level — the same technique as runbook-date-wiring.spec.ts, and for
 * the same reason: decision 123's date parser was fixed at one door and the
 * other door kept its own spelling for four audit passes.
 */
describe('runbook year/month wiring (audit B-2 — one border, every door)', () => {
  const jobSource = (file: string): string =>
    readFileSync(join(process.cwd(), 'src/main/jobs', file), 'utf-8');

  it.each(['close-billing-period.ts', 'reopen-billing-period.ts'])(
    '%s MUST parse --year/--month through parseRunbookYearMonth — never a bare Number()',
    (file) => {
      const source = jobSource(file);

      expect(source).toContain('parseRunbookYearMonth(values.year, values.month)');
      expect(source).not.toMatch(/Number\(values\.(year|month)\)/);
    },
  );
});
