import { CloseBillingPeriodResult } from '@observability/core/domain/useCases/close-billing-period-use-case.js';
import { formatBrlFromCents } from '@observability/core/common/helpers/money/money.js';

/**
 * The US5 notification, spelled ONCE: both close doors — the runbook job
 * (decision 87) and the auto-close scheduler (decision 131) — print these
 * exact lines, so the admin reads one vocabulary whoever closed the month.
 */
export const formatCloseSuccess = (
  result: CloseBillingPeriodResult,
): string[] => {
  const { year, month } = result;
  const lines = [
    `✔ Mês ${year}-${String(month).padStart(2, '0')} FECHADO — ` +
      `total final R$ ${formatBrlFromCents(result.totalDisplayCents)} ` +
      `(${result.stampedTraceCount} execuções, snapshot v${result.snapshotVersion}` +
      `${result.ingestionWatermark ? `, dados até ${result.ingestionWatermark.toISOString()}` : ''}).`,
    'O extrato congelado é a base da fatura: GET /api/v1/billing/summary' +
      `?year=${year}&month=${month} (export: /billing/statement?format=csv|html).`,
  ];

  // Decision 100 — the snapshot adjudicates: report what the post-close
  // reconciliation did (stragglers flagged / quarentenados absorvidos).
  if (result.quarantine.flaggedStragglers > 0 || result.quarantine.absorbed > 0) {
    lines.push(
      `Quarentena reconciliada: ${result.quarantine.flaggedStragglers} ` +
        'trace(s) retardatário(s) sinalizado(s) fora da fatura; ' +
        `${result.quarantine.absorbed} quarentenado(s) absorvido(s) pelo ` +
        `snapshot v${result.snapshotVersion} (agora faturados).`,
    );
  }

  return lines;
};
