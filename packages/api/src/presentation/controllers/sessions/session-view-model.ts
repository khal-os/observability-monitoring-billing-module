import { SessionSummaryModel } from '../../../domain/models/session-model.js';
import { SessionDetail } from '../../../domain/useCases/get-session-detail-use-case.js';
import { formatBrlFromMicrocents } from '../../../common/helpers/money/money.js';
import {
  contentToText,
  formatAgeDisplay,
  formatBrlDisplay,
  formatDateTimeDisplay,
  formatDurationDisplay,
  formatIntDisplay,
} from '../../../common/helpers/display/display.js';
import { toTraceListItem } from '../traces/trace-view-model.js';
import {
  SessionDetailView,
  SessionListItemView,
} from './session-view-schemas.js';

/**
 * Whitelist projection, R$ only (invariant 4). Cost honesty (invariant 2):
 * while any member trace is pending_price, `cost_brl` is null — the
 * PARTIAL stamped sum is exposed separately and the pending count says
 * why. A session is never silently valued at R$ 0.
 *
 * Sessions are a DERIVED read-model (decision 51): aggregates come from
 * the query-time grouping; display projections are computed here per
 * request — nothing session-level is consolidated in the store.
 */
export const toSessionListItem = (
  session: SessionSummaryModel,
  now: Date,
): SessionListItemView => {
  const tokensTotal =
    (session.tokens.input ?? 0) +
    (session.tokens.output ?? 0) +
    (session.tokens.cache_read ?? 0) +
    (session.tokens.cache_write ?? 0);
  const stampedCostBrl = formatBrlFromMicrocents(session.stampedCostMicrocents);
  const isFullyStamped = session.pendingPriceCount === 0;

  return {
    session_id: session.sessionId,
    user_id: session.userId ?? null,
    // Full block of the session's FIRST trace: which agent build served the
    // conversation (user decision — consistent with the traces list).
    // Domain/subdomain are trace-level attributes → root (decision 20).
    agent: {
      id: session.agent?.id ?? null,
      version: session.agent?.version ?? null,
      instance: session.agent?.instance ?? null,
    },
    agent_label: session.agent?.id ?? '(sem agente)',
    domain: session.domain ?? null,
    subdomain: session.subdomain ?? null,
    scope_label:
      [session.domain, session.subdomain].filter(Boolean).join(' · ') || null,
    trace_count: session.traceCount,
    status: session.status,
    total_duration_ms: session.totalDurationMs,
    total_duration_display: formatDurationDisplay(session.totalDurationMs),
    tokens_in: session.tokens.input ?? 0,
    tokens_in_display: formatIntDisplay(session.tokens.input ?? 0),
    tokens_out: session.tokens.output ?? 0,
    tokens_out_display: formatIntDisplay(session.tokens.output ?? 0),
    tokens_total: tokensTotal,
    tokens_total_display: formatIntDisplay(tokensTotal),
    pending_price_count: session.pendingPriceCount,
    cost_brl: isFullyStamped ? stampedCostBrl : null,
    cost_brl_display: isFullyStamped ? formatBrlDisplay(stampedCostBrl) : null,
    stamped_cost_brl_partial: isFullyStamped ? null : stampedCostBrl,
    stamped_cost_brl_partial_display: isFullyStamped
      ? null
      : formatBrlDisplay(stampedCostBrl),
    started_at: session.startedAt.toISOString(),
    started_at_display: formatDateTimeDisplay(session.startedAt),
    last_activity_at: session.lastActivityAt.toISOString(),
    last_activity_at_display: formatDateTimeDisplay(session.lastActivityAt),
    age_display: formatAgeDisplay(session.lastActivityAt, now),
  };
};

export const toSessionDetail = (
  detail: SessionDetail,
  now: Date,
): SessionDetailView => ({
  ...toSessionListItem(detail.summary, now),
  // The conversation chain (US22): each step carries its own stamped cost
  // and content — the session cost is visibly the sum of its traces.
  chain: detail.chain.map((trace) => ({
    ...toTraceListItem(trace, now),
    input: trace.input ?? null,
    output: trace.output ?? null,
    input_text: contentToText(trace.input),
    output_text: contentToText(trace.output),
  })),
});
