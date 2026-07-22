import { TraceModel } from '../../../core/models/trace-model.js';
import { SpanModel } from '../../../core/models/span-model.js';
import {
  formatBrlExactFromMicrocents,
  formatBrlFromMicrocents,
} from '../../../common/helpers/money/money.js';
import {
  contentToText,
  formatAgeDisplay,
  formatBrlDisplay,
  formatDateTimeDisplay,
  formatDurationDisplay,
  formatIntDisplay,
  formatUtcDateDisplay,
} from '../../../common/helpers/display/display.js';
import { TraceDetailView, TraceListItemView } from './trace-view-schemas.js';

/**
 * Client-facing projections are WHITELISTS built field by field — R$ only
 * by construction (invariant 4). Internal fields (US$, PTAX, markup, µ¢
 * integers, Mongo _id) simply do not exist in these schemas. Costs come
 * from the ingestion-time stamp — the same number billing sums (T10).
 *
 * Every derived/formatted value the UI needs is produced HERE (decision
 * 51): consolidated snapshot fields (tokensTotal, offsetMs) come stored
 * from ingestion; display strings and waterfall geometry are projected
 * per request. `now` anchors relative-age strings.
 */
export const toTraceListItem = (
  trace: TraceModel,
  now: Date,
): TraceListItemView => ({
  trace_id: trace.traceId,
  session_id: trace.sessionId ?? null,
  // Full point-in-time blocks already at list level (user decision): which
  // agent BUILD and omni deployment served each execution. Domain/subdomain
  // are TRACE-level attributes (decision 20) — they live at the root.
  agent: {
    id: trace.agent?.id ?? null,
    version: trace.agent?.version ?? null,
    instance: trace.agent?.instance ?? null,
  },
  agent_label: trace.agent?.id ?? '(sem agente)',
  domain: trace.domain ?? null,
  subdomain: trace.subdomain ?? null,
  scope_label:
    [trace.domain, trace.subdomain].filter(Boolean).join(' · ') || null,
  type: trace.type,
  channel: {
    type: trace.channel.type,
    version: trace.channel.version ?? null,
    instance: trace.channel.instance ?? null,
  },
  status: trace.status,
  duration_ms: trace.durationMs,
  duration_display: formatDurationDisplay(trace.durationMs),
  tokens_in: trace.tokens.input ?? 0,
  tokens_in_display: formatIntDisplay(trace.tokens.input ?? 0),
  tokens_out: trace.tokens.output ?? 0,
  tokens_out_display: formatIntDisplay(trace.tokens.output ?? 0),
  tokens_total: trace.tokensTotal,
  tokens_total_display: formatIntDisplay(trace.tokensTotal),
  pricing_status: trace.pricingStatus,
  cost_brl:
    trace.pricingStatus === 'stamped' && trace.totalCostMicrocents != null
      ? formatBrlFromMicrocents(trace.totalCostMicrocents)
      : null,
  cost_brl_display:
    trace.pricingStatus === 'stamped' && trace.totalCostMicrocents != null
      ? formatBrlDisplay(formatBrlFromMicrocents(trace.totalCostMicrocents))
      : null,
  started_at: trace.startedAt.toISOString(),
  started_at_display: formatDateTimeDisplay(trace.startedAt),
  age_display: formatAgeDisplay(trace.startedAt, now),
});

/**
 * Waterfall geometry from the CONSOLIDATED offset (never re-derived from
 * timestamps): clipped to the trace window on both ends, as percentages
 * of the trace duration.
 */
const waterfallGeometry = (span: SpanModel, traceDurationMs: number) => {
  const total = Math.max(traceDurationMs, 1);
  const clippedStart = Math.min(Math.max(span.offsetMs, 0), total);
  const clippedEnd = Math.min(
    Math.max(span.offsetMs + span.durationMs, clippedStart),
    total,
  );
  const round2 = (value: number) => Math.round(value * 100) / 100;

  return {
    left_percent: round2((clippedStart / total) * 100),
    width_percent: round2(((clippedEnd - clippedStart) / total) * 100),
  };
};

const toSpanItem = (span: SpanModel, traceDurationMs: number) => ({
  span_id: span.spanId,
  type: span.type,
  name: span.name,
  label: span.name === span.type ? span.name : `${span.name} · ${span.type}`,
  status: span.status,
  error_message: span.errorMessage ?? null,
  started_at: span.startedAt.toISOString(),
  finished_at: span.finishedAt.toISOString(),
  duration_ms: span.durationMs,
  duration_display: formatDurationDisplay(span.durationMs),
  offset_ms: span.offsetMs,
  waterfall: waterfallGeometry(span, traceDurationMs),
  tokens: {
    input: span.tokens?.input ?? 0,
    output: span.tokens?.output ?? 0,
    cache_read: span.tokens?.cache_read ?? 0,
    cache_write: span.tokens?.cache_write ?? 0,
  },
  input: span.input ?? null,
  output: span.output ?? null,
  input_text: contentToText(span.input),
  output_text: contentToText(span.output),
});

export const toTraceDetail = (trace: TraceModel, now: Date): TraceDetailView => ({
  ...toTraceListItem(trace, now),
  finished_at: trace.finishedAt.toISOString(),
  finished_at_display: formatDateTimeDisplay(trace.finishedAt),
  model: trace.model ?? null,
  tokens: {
    input: trace.tokens.input ?? 0,
    output: trace.tokens.output ?? 0,
    cache_read: trace.tokens.cache_read ?? 0,
    cache_write: trace.tokens.cache_write ?? 0,
  },
  tokens_display: {
    input: formatIntDisplay(trace.tokens.input ?? 0),
    output: formatIntDisplay(trace.tokens.output ?? 0),
    cache_read: formatIntDisplay(trace.tokens.cache_read ?? 0),
    cache_write: formatIntDisplay(trace.tokens.cache_write ?? 0),
  },
  span_count: trace.spans.length,
  span_types: [...new Set(trace.spans.map((span) => span.type))],
  unclassified_reasons: trace.unclassified?.reasons ?? null,
  unclassified_label: trace.unclassified?.reasons.join('; ') ?? null,
  pending_missing_token_types:
    trace.pendingPrice?.missingTokenTypes ?? null,
  pending_missing_label:
    trace.pendingPrice?.missingTokenTypes.join(', ') ?? null,
  // "Shows the math": contracted R$ price and full-precision line cost per
  // token type; only the trace total gets display rounding (T5).
  costs:
    trace.stampedCosts?.map((cost) => ({
      token_type: cost.tokenType,
      tokens: cost.tokens,
      tokens_display: formatIntDisplay(cost.tokens),
      applied_price_brl_per_million: formatBrlExactFromMicrocents(
        cost.appliedPriceMicrocentsPerMillion,
      ),
      applied_price_display: `${formatBrlDisplay(
        formatBrlExactFromMicrocents(cost.appliedPriceMicrocentsPerMillion),
      )}/M`,
      applied_price_effective_from:
        cost.appliedPriceEffectiveFrom.toISOString(),
      applied_price_effective_from_display: formatUtcDateDisplay(
        cost.appliedPriceEffectiveFrom,
      ),
      cost_brl_exact: formatBrlExactFromMicrocents(cost.costMicrocents),
      cost_brl_exact_display: formatBrlDisplay(
        formatBrlExactFromMicrocents(cost.costMicrocents),
      ),
    })) ?? null,
  // Price versions are per (model, token type) with independent effective
  // dates — a single trace-wide "vigente desde" only exists when every
  // stamped line shares the SAME date; otherwise null and the UI omits it.
  costs_effective_from_display: (() => {
    const dates = [
      ...new Set(
        (trace.stampedCosts ?? []).map((cost) =>
          formatUtcDateDisplay(cost.appliedPriceEffectiveFrom),
        ),
      ),
    ];

    return dates.length === 1 ? (dates[0] as string) : null;
  })(),
  spans: trace.spans.map((span) => toSpanItem(span, trace.durationMs)),
  content: {
    input: trace.input ?? null,
    output: trace.output ?? null,
    input_text: contentToText(trace.input),
    output_text: contentToText(trace.output),
  },
});
