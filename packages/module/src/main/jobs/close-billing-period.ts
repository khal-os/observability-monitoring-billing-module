import { parseArgs } from 'node:util';
import { makeDatabase } from '../factories/database-factory.js';
import { makeCloseBillingPeriodUseCase } from '../factories/billing-factory.js';
import {
  BillingCloseBlockedError,
  BillingPeriodStateError,
} from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { formatBrlFromCents } from '@observability/core/common/helpers/money/money.js';

/**
 * T6 runbook (decision 87 — the ONLY close trigger in v1): freezes a
 * fully-past month into its audit snapshot. The job's output IS the US5
 * notification: closed with the final total, or blocked with the reason.
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

const year = Number(values.year);
const month = Number(values.month);

if (!Number.isInteger(year) || !Number.isInteger(month)) {
  console.error('Usage: npm run billing:close -- --year <YYYY> --month <1-12>');
  process.exit(1);
}

const database = makeDatabase();

await database.connect();

try {
  const result = await makeCloseBillingPeriodUseCase().close(year, month);

  console.log(
    `✔ Mês ${year}-${String(month).padStart(2, '0')} FECHADO — ` +
      `total final R$ ${formatBrlFromCents(result.totalDisplayCents)} ` +
      `(${result.stampedTraceCount} execuções, snapshot v${result.snapshotVersion}` +
      `${result.ingestionWatermark ? `, dados até ${result.ingestionWatermark.toISOString()}` : ''}).`,
  );
  console.log(
    'O extrato congelado é a base da fatura: GET /api/v1/billing/summary' +
      `?year=${year}&month=${month} (export: /billing/statement?format=csv|html).`,
  );

  // Decision 100 — the snapshot adjudicates: report what the post-close
  // reconciliation did (stragglers flagged / quarentenados absorvidos).
  if (result.quarantine.flaggedStragglers > 0 || result.quarantine.absorbed > 0) {
    console.log(
      `Quarentena reconciliada: ${result.quarantine.flaggedStragglers} ` +
        'trace(s) retardatário(s) sinalizado(s) fora da fatura; ' +
        `${result.quarantine.absorbed} quarentenado(s) absorvido(s) pelo ` +
        `snapshot v${result.snapshotVersion} (agora faturados).`,
    );
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
