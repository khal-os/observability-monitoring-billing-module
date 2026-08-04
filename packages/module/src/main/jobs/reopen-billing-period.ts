import { parseArgs } from 'node:util';
import {
  RUNBOOK_YEAR_MONTH_HINT,
  parseRunbookYearMonth,
} from '@observability/core/common/helpers/parse-runbook-year-month.js';
import { makeDatabase } from '../factories/database-factory.js';
import { makeReopenBillingPeriodUseCase } from '../factories/billing-factory.js';
import { BillingPeriodStateError } from '@observability/core/domain/useCases/close-billing-period-use-case.js';

/**
 * T6 runbook: audited reopen of a closed month — REASON is mandatory and
 * lands in the period's append-only audit trail (shown on the statement).
 * Prior snapshot versions are preserved; the next close writes v+1.
 *
 * Usage:
 *   npm run billing:reopen -- --year 2026 --month 6 --reason "correção de atribuição do agente X"
 */
const { values } = parseArgs({
  options: {
    year: { type: 'string' },
    month: { type: 'string' },
    reason: { type: 'string' },
  },
});

// Same year/month border as the close job and the HTTP door (audit B-2).
const period = parseRunbookYearMonth(values.year, values.month);
const reason = values.reason ?? '';

if (!period || !reason.trim()) {
  console.error(
    'Usage: npm run billing:reopen -- --year <YYYY> --month <1-12> --reason "<motivo auditado>"',
  );
  if (!period) {
    console.error(
      `--year "${values.year}" --month "${values.month}": ${RUNBOOK_YEAR_MONTH_HINT}`,
    );
  }
  process.exit(1);
}

const { year, month } = period;

const database = makeDatabase();

await database.connect();

try {
  const result = await makeReopenBillingPeriodUseCase().reopen(
    year,
    month,
    reason,
  );

  console.log(
    `✔ Mês ${year}-${String(month).padStart(2, '0')} REABERTO ` +
      `(snapshot v${result.previousSnapshotVersion} preservado; o próximo ` +
      `fechamento grava v${result.previousSnapshotVersion + 1}).`,
  );
  console.log(
    'O mês volta a servir ao vivo; carimbo de pendentes desbloqueado; ' +
      'motivo registrado na auditoria do período.',
  );
} catch (error) {
  if (error instanceof BillingPeriodStateError) {
    console.error(`✖ ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await database.disconnect();
}
