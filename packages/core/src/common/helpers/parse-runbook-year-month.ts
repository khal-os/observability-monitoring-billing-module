/**
 * THE year/month border of every runbook door (audit B-2) — the sibling of
 * parse-runbook-date.ts, named after the RULE, not a door (naming the date
 * parser after one door is exactly what let the other door keep its own
 * spelling for four audit passes; decision 123's postmortem).
 *
 * Why it exists: the close/reopen jobs validated only Number.isInteger,
 * while the HTTP door for the SAME two values was bounded (1970-9999 /
 * 1-12). `make billing-close YEAR=26 MONTH=6` therefore closed June
 * **1926** — Date.UTC maps years 0-99 into 1900-1999 — and SUCCEEDED: the
 * window was fully past, empty and pending-free, so a zero-total snapshot
 * and a `{year: 26, status: 'closed'}` period document were persisted. That
 * document then anchored `firstOpenMonthStart` at 1926, silently destroying
 * the decision-119 live-scan bound: every /bills and /billing/series
 * reverted to a full-collection scan over full-content trace documents.
 *
 * `monthWindowUtc` carries the same bounds as a structural backstop; this
 * helper is the door-level half that answers with a usage message naming
 * the offending value instead of a raw stack.
 */
export const RUNBOOK_YEAR_MONTH_HINT =
  'Ano completo com 4 dígitos (1970-9999) e mês 1-12 — ' +
  '"--year 26" seria lido como 1926 pelo calendário JS, e um fechamento ' +
  'de 1926 destrói o bound de varredura dos meses abertos (decisão 119).';

export interface RunbookYearMonth {
  year: number;
  month: number;
}

export const parseRunbookYearMonth = (
  rawYear: string | undefined,
  rawMonth: string | undefined,
): RunbookYearMonth | null => {
  if (!/^\d{4}$/.test(rawYear ?? '')) return null;
  if (!/^\d{1,2}$/.test(rawMonth ?? '')) return null;

  const year = Number(rawYear);
  const month = Number(rawMonth);

  if (year < 1970 || year > 9999) return null;
  if (month < 1 || month > 12) return null;

  return { year, month };
};
