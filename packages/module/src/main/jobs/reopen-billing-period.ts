import { parseArgs } from 'node:util';
import { makeDatabase } from '../factories/database-factory.js';
import { makeReopenBillingPeriodUseCase } from '../factories/billing-factory.js';
import { BillingPeriodStateError } from '@khal/core/domain/useCases/close-billing-period-use-case.js';

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

const year = Number(values.year);
const month = Number(values.month);
const reason = values.reason ?? '';

if (!Number.isInteger(year) || !Number.isInteger(month) || !reason.trim()) {
  console.error(
    'Usage: npm run billing:reopen -- --year <YYYY> --month <1-12> --reason "<motivo auditado>"',
  );
  process.exit(1);
}

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
