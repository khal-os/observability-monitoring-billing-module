import {
  BillingSummary,
  BillingSummaryLine,
} from '../../../domain/useCases/get-billing-summary-use-case.js';
import { BillListItem } from '../../../domain/useCases/list-bills-use-case.js';
import { TokenType } from '../../../domain/models/price-version-model.js';
import {
  formatBrlExactFromMicrocents,
  formatBrlFromCents,
  formatBrlFromMicrocents,
  reconcileDisplayCents,
} from '../../../common/helpers/money/money.js';
import {
  formatBrlDisplay,
  formatIntDisplay,
  formatMonthLabel,
} from '../../../common/helpers/display/display.js';
import { BillListView, BillingSummaryView } from './billing-view-schemas.js';

const TOKEN_TYPE_ORDER: TokenType[] = [
  'input',
  'output',
  'cache_read',
  'cache_write',
];

const round2 = (value: number): number => Math.round(value * 100) / 100;

type LineView = BillingSummaryView['lines'][number];

const toLineView = (
  line: BillingSummaryLine,
  displayCents: number,
): LineView => ({
  agent_id: line.agentId,
  agent_version: line.agentVersion,
  model: line.model,
  model_label: line.model ?? '(sem modelo)',
  token_type: line.tokenType,
  tokens: line.tokens,
  tokens_display: formatIntDisplay(line.tokens),
  cost_brl_exact: formatBrlExactFromMicrocents(line.costMicrocents),
  cost_brl_exact_display: formatBrlDisplay(
    formatBrlExactFromMicrocents(line.costMicrocents),
  ),
  cost_brl_display: formatBrlFromCents(displayCents),
  cost_brl_display_brl: formatBrlDisplay(formatBrlFromCents(displayCents)),
});

/**
 * Agent × version groups with API-computed bar geometry (decision 51):
 * groups sort by exact cost desc; the most expensive agent's bar spans
 * 100% of the track and every segment width is a percent of that same
 * track, so the front lays them out with zero math. Group display values
 * are sums of the RECONCILED line cents — groups close with the total
 * exactly like the lines do (T5).
 */
const toAgentGroups = (
  lines: BillingSummaryLine[],
  lineViews: LineView[],
): BillingSummaryView['agents'] => {
  interface Group {
    agentId: string | null;
    agentVersion: string | null;
    costMicrocents: number;
    displayCents: number;
    tokens: number;
    byType: Map<TokenType, number>;
    lineViews: LineView[];
  }

  const groups = new Map<string, Group>();

  lines.forEach((line, index) => {
    const key = `${line.agentId ?? ''}@@${line.agentVersion ?? ''}`;
    let group = groups.get(key);

    if (!group) {
      group = {
        agentId: line.agentId,
        agentVersion: line.agentVersion,
        costMicrocents: 0,
        displayCents: 0,
        tokens: 0,
        byType: new Map(),
        lineViews: [],
      };
      groups.set(key, group);
    }

    group.costMicrocents += line.costMicrocents;
    group.displayCents += Math.round(
      Number((lineViews[index] as LineView).cost_brl_display) * 100,
    );
    group.tokens += line.tokens;
    group.byType.set(
      line.tokenType,
      (group.byType.get(line.tokenType) ?? 0) + line.costMicrocents,
    );
    group.lineViews.push(lineViews[index] as LineView);
  });

  const sorted = [...groups.values()].sort(
    (a, b) => b.costMicrocents - a.costMicrocents,
  );
  const maxCost = sorted[0]?.costMicrocents ?? 0;

  return sorted.map((group) => ({
    agent_id: group.agentId,
    agent_version: group.agentVersion,
    agent_label: group.agentId ?? '(sem agente)',
    version_label: group.agentVersion ? `v${group.agentVersion}` : null,
    tokens_total: group.tokens,
    tokens_total_display: formatIntDisplay(group.tokens),
    cost_brl_display: formatBrlDisplay(formatBrlFromCents(group.displayCents)),
    bar_width_percent:
      maxCost > 0 ? round2((group.costMicrocents / maxCost) * 100) : 0,
    segments: TOKEN_TYPE_ORDER.filter(
      (tokenType) => (group.byType.get(tokenType) ?? 0) > 0,
    ).map((tokenType) => ({
      token_type: tokenType,
      width_percent:
        maxCost > 0
          ? round2(((group.byType.get(tokenType) ?? 0) / maxCost) * 100)
          : 0,
      label: `${tokenType} · ${formatBrlDisplay(
        formatBrlExactFromMicrocents(group.byType.get(tokenType) ?? 0),
      )}`,
    })),
    lines: group.lineViews,
  }));
};

/**
 * Whitelist projection, R$ only by construction (invariant 4) — internal
 * fields and µ¢ integers never leave the API.
 *
 * Display rule (T5): each line keeps its exact cost; displayed line values
 * are reconciled by largest remainder so the displayed parts sum EXACTLY
 * to the displayed total. Pending traces are reported apart — the total
 * never silently absorbs them as R$ 0 (invariant 2).
 */
export const toBillingSummaryView = (
  summary: BillingSummary,
): BillingSummaryView => {
  const { totalCents, partsCents } = reconcileDisplayCents(
    summary.lines.map((line) => line.costMicrocents),
  );
  const lineViews = summary.lines.map((line, index) =>
    toLineView(line, partsCents[index] as number),
  );
  const stampedTokensTotal = summary.lines.reduce(
    (sum, line) => sum + line.tokens,
    0,
  );
  const agents = toAgentGroups(summary.lines, lineViews);
  const pendingTokensTotal =
    (summary.pendingPrice.tokens.input ?? 0) +
    (summary.pendingPrice.tokens.output ?? 0) +
    (summary.pendingPrice.tokens.cache_read ?? 0) +
    (summary.pendingPrice.tokens.cache_write ?? 0);

  return {
    year: summary.year,
    month: summary.month,
    month_label: formatMonthLabel(summary.year, summary.month),
    period_status: summary.periodStatus,
    partial: summary.periodStatus === 'in_progress',
    total_cost_brl: formatBrlFromCents(totalCents),
    total_cost_brl_display: formatBrlDisplay(formatBrlFromCents(totalCents)),
    stamped_tokens_total: stampedTokensTotal,
    stamped_tokens_total_display: formatIntDisplay(stampedTokensTotal),
    agent_count: agents.length,
    model_count: new Set(
      summary.lines.map((line) => line.model).filter(Boolean),
    ).size,
    lines: lineViews,
    agents,
    pending_price: {
      trace_count: summary.pendingPrice.traceCount,
      tokens: {
        input: summary.pendingPrice.tokens.input ?? 0,
        output: summary.pendingPrice.tokens.output ?? 0,
        cache_read: summary.pendingPrice.tokens.cache_read ?? 0,
        cache_write: summary.pendingPrice.tokens.cache_write ?? 0,
      },
      tokens_total: pendingTokensTotal,
      tokens_total_display: formatIntDisplay(pendingTokensTotal),
      models: summary.pendingPrice.models,
      models_label: summary.pendingPrice.models.join(', '),
    },
  };
};

/** Same whitelist discipline as the summary: R$ only, display rounding half-up. */
export const toBillListView = (bills: BillListItem[]): BillListView => ({
  bills: bills.map((bill) => ({
    year: bill.year,
    month: bill.month,
    month_label: formatMonthLabel(bill.year, bill.month),
    period_status: bill.periodStatus,
    partial: bill.periodStatus === 'in_progress',
    status_label:
      bill.periodStatus === 'in_progress' ? 'mês em andamento' : 'aberto',
    total_cost_brl: formatBrlFromMicrocents(bill.totalCostMicrocents),
    total_cost_brl_display: formatBrlDisplay(
      formatBrlFromMicrocents(bill.totalCostMicrocents),
    ),
    stamped_trace_count: bill.stampedTraceCount,
    pending_trace_count: bill.pendingTraceCount,
    tokens: bill.tokens,
    tokens_display: formatIntDisplay(bill.tokens),
  })),
});
