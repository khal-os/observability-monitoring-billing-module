import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Decision 123's connector half: `make sync` is both the only manual
 * backfill door into the permanent archive and the dead-letter recovery
 * door — a silently-different window loses the trace twice (invariant 6).
 * Parser behavior is specced next to it in @observability/core; the job is a
 * top-level-await script that connects the database on import, so its ONE
 * line of wiring is pinned here at source level (same technique as
 * architecture-boundaries): putting `new Date(values['from'])` back would
 * restore the divergence with every behavior assertion still green.
 */
describe('runbook date wiring (decision 123, sync door)', () => {
  const job = readFileSync(join(__dirname, 'run-sync.ts'), 'utf-8');

  it('MUST be the border run-sync.ts actually uses', () => {
    expect(job).toContain(
      "from '@observability/core/common/helpers/parse-runbook-date.js'",
    );
    expect(job).toContain("parseRunbookDate(values['from'])");
    expect(job).toContain("parseRunbookDate(values['to'])");
    expect(job).not.toContain("new Date(values['from'])");
    expect(job).not.toContain("new Date(values['to'])");
  });

  /**
   * Found by running the built job, not by reading it: an unparseable date
   * and an out-of-order window are DIFFERENT operator errors and must not
   * share one message. Folded together, `--from 01/07/2026 --to 15/07/2026`
   * answered "--from must be strictly before --to" — ordered, in the reading
   * that produced them — pointing the operator away from the actual problem
   * on the one door decision 123 exists to keep honest about dates.
   */
  it('MUST diagnose an unparseable date separately from an out-of-order window', () => {
    // Anchored on the emitted string, not the bare phrase: the comment above
    // the guard quotes the old message, and matching prose instead of code is
    // exactly how a source-level pin stops testing anything.
    const ordering = job.indexOf("'Sync: --from must be strictly before");
    const fromHint = job.indexOf('Invalid --from');
    const toHint = job.indexOf('Invalid --to');

    expect(fromHint).toBeGreaterThan(-1);
    expect(toHint).toBeGreaterThan(-1);

    // The ordering message must be reached only AFTER both parses succeeded,
    // and must not carry the format hint that belongs to the parse failures.
    expect(ordering).toBeGreaterThan(fromHint);
    expect(ordering).toBeGreaterThan(toHint);
    expect(job).not.toContain(
      'strictly before --to. ${RUNBOOK_DATE_FORMAT_HINT}',
    );
  });
});
