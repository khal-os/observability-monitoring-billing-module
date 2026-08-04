import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Decision 131 wiring, pinned at SOURCE level (the runbook-wiring
 * technique — the scheduler is a top-level-await script that connects the
 * database on import): the scheduler must reach the close ONLY through
 * the factory composed with trigger 'scheduled', and the runbook door
 * must keep its default — an audit trail that says who closed the month
 * is only worth what these pins enforce.
 */
describe('billing scheduler wiring (decision 131 — one close, two honest doors)', () => {
  const source = (relativePath: string): string =>
    readFileSync(join(process.cwd(), 'src', relativePath), 'utf-8');

  it('the scheduler job MUST compose through the factory — never storage directly', () => {
    const scheduler = source('main/jobs/run-billing-close-scheduler.ts');

    expect(scheduler).toContain('makeCloseDueBillingPeriodsUseCase(');
    // \s escapes keep this file's own source free of an import-shaped
    // "from '…'" sequence the architecture scanner would flag.
    expect(scheduler).not.toMatch(new RegExp(String.raw`new MongoDb|from\s+'mongodb'`));
  });

  it("the factory MUST compose the scheduler's close with trigger 'scheduled' exactly once", () => {
    const factory = source('main/factories/billing-factory.ts');

    const scheduled = factory.match(/makeCloseBillingPeriodUseCase\('scheduled'\)/g);

    expect(scheduled).toHaveLength(1);
  });

  it("the runbook close job MUST NOT mention 'scheduled' — its door defaults to 'runbook'", () => {
    const runbookJob = source('main/jobs/close-billing-period.ts');

    expect(runbookJob).not.toContain("'scheduled'");
  });

  it('the two doors MUST print the same success block (one US5 spelling)', () => {
    const runbookJob = source('main/jobs/close-billing-period.ts');
    const scheduler = source('main/jobs/run-billing-close-scheduler.ts');

    expect(runbookJob).toContain('formatCloseSuccess(');
    expect(scheduler).toContain('formatCloseSuccess(');
  });
});
