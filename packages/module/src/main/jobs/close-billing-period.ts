import { parseArgs } from 'node:util';
import {
  RUNBOOK_YEAR_MONTH_HINT,
  parseRunbookYearMonth,
} from '@observability/core/common/helpers/parse-runbook-year-month.js';
import { makeDatabase } from '../factories/database-factory.js';
import { makeCloseBillingPeriodUseCase } from '../factories/billing-factory.js';
import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
} from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { formatCloseSuccess } from './helpers/format-close-result.js';

/**
 * T6 runbook (decision 87): freezes a fully-past month into its audit
 * snapshot. The job's output IS the US5 notification: closed with the
 * final total, or blocked with the reason. (The opt-in auto-close
 * scheduler — decision 131 — is the other door to the SAME use case.)
 *
 * Usage:
 *   npm run billing:close -- --year 2026 --month 6
 */
const { values } = parseArgs({
  options: {
    year: { type: 'string' },
    month: { type: 'string' },
  },
});

// One border for every runbook year/month door (audit B-2) — the same
// bounds as the HTTP query shape, so "--year 26" is refused instead of
// closing June 1926 and anchoring the live-scan bound there forever.
const period = parseRunbookYearMonth(values.year, values.month);

if (!period) {
  console.error('Usage: npm run billing:close -- --year <YYYY> --month <1-12>');
  console.error(`--year "${values.year}" --month "${values.month}": ${RUNBOOK_YEAR_MONTH_HINT}`);
  process.exit(1);
}

const { year, month } = period;

const database = makeDatabase();

await database.connect();

try {
  const result = await makeCloseBillingPeriodUseCase().close(year, month);

  for (const line of formatCloseSuccess(result)) {
    console.log(line);
  }
} catch (error) {
  if (
    error instanceof BillingCloseBlockedError ||
    error instanceof BillingPeriodStateError
  ) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await database.disconnect();
}
