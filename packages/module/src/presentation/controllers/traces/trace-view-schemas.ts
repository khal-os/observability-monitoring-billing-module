import { z } from 'zod';
import {
  executionStatusSchema,
  paginatedSchema,
  pricingStatusSchema,
  tokenCountsViewSchema,
  tokenTypeSchema,
} from '../../helpers/docs-schemas.js';

const agentBlockSchema = z.strictObject({
  id: z.string().nullable(),
  version: z.string().nullable(),
  instance: z.string().nullable(),
});

const channelBlockSchema = z.strictObject({
  type: z.string(),
  version: z.string().nullable(),
  instance: z.string().nullable(),
});

/** A/B arm that served the execution — display only (decision 70). */
const experimentBlockSchema = z.strictObject({
  name: z.string(),
  variant: z.string(),
  variant_version: z.string().nullable(),
});

/**
 * Display fields (`*_display`, `*_label`) are part of the contract
 * (decision 51): the API owns every derived/formatted value and the
 * front-end only binds fields — no data processing client-side.
 */
export const traceListItemSchema = z.strictObject({
  trace_id: z.string(),
  session_id: z.string().nullable(),
  user_id: z.string().nullable(),
  agent: agentBlockSchema,
  agent_label: z.string(),
  domain: z.string().nullable(),
  subdomain: z.string().nullable(),
  scope_label: z.string().nullable(),
  environment: z.string().nullable(),
  experiment: experimentBlockSchema.nullable(),
  type: z.string(),
  channel: channelBlockSchema,
  status: executionStatusSchema,
  duration_ms: z.number().int(),
  duration_display: z.string(),
  tokens_in: z.number().int(),
  tokens_in_display: z.string(),
  tokens_out: z.number().int(),
  tokens_out_display: z.string(),
  tokens_total: z.number().int(),
  tokens_total_display: z.string(),
  pricing_status: pricingStatusSchema,
  cost_brl: z.string().nullable(),
  cost_brl_display: z.string().nullable(),
  started_at: z.string(),
  started_at_display: z.string(),
  age_display: z.string(),
});

/**
 * Traces pagination carries the capped-total contract (decision 77):
 * exact totals for arbitrary filters are O(matching docs) at 1M+ scale,
 * so counting stops at the cap and displays carry a trailing "+".
 */
export const traceListResponseSchema = paginatedSchema(
  traceListItemSchema,
).extend({
  total_capped: z.boolean(),
  total_display: z.string(),
  total_pages_display: z.string(),
});

const traceFilterOptionSchema = z.strictObject({
  value: z.string(),
  count: z.number().int(),
});

/**
 * Filter-bar dropdown options: STORED values per filterable field
 * (agents = agent ids, channels = channel types), cascading with
 * self-exclusion. Each count is the "what-if" number: traces matching
 * the value combined with the OTHER fields' active filters.
 */
export const traceFilterOptionsResponseSchema = z.strictObject({
  domains: z.array(traceFilterOptionSchema),
  subdomains: z.array(traceFilterOptionSchema),
  types: z.array(traceFilterOptionSchema),
  agents: z.array(traceFilterOptionSchema),
  channels: z.array(traceFilterOptionSchema),
  statuses: z.array(
    z.strictObject({
      value: executionStatusSchema,
      count: z.number().int(),
    }),
  ),
});

const waterfallGeometrySchema = z.strictObject({
  left_percent: z.number(),
  width_percent: z.number(),
});

const spanViewSchema = z.strictObject({
  span_id: z.string(),
  type: z.string(),
  name: z.string(),
  label: z.string(),
  status: executionStatusSchema,
  error_message: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number().int(),
  duration_display: z.string(),
  offset_ms: z.number().int(),
  waterfall: waterfallGeometrySchema,
  tokens: tokenCountsViewSchema,
  input: z.unknown(),
  output: z.unknown(),
  input_text: z.string().nullable(),
  output_text: z.string().nullable(),
});

const traceCostViewSchema = z.strictObject({
  token_type: tokenTypeSchema,
  tokens: z.number().int(),
  tokens_display: z.string(),
  applied_price_brl_per_million: z.string(),
  applied_price_display: z.string(),
  applied_price_effective_from: z.string(),
  applied_price_effective_from_display: z.string(),
  cost_brl_exact: z.string(),
  cost_brl_exact_display: z.string(),
});

const traceContentViewSchema = z.strictObject({
  input: z.unknown(),
  output: z.unknown(),
  input_text: z.string().nullable(),
  output_text: z.string().nullable(),
});

export const traceDetailResponseSchema = traceListItemSchema
  .extend({
    finished_at: z.string(),
    finished_at_display: z.string(),
    model: z.string().nullable(),
    tokens: tokenCountsViewSchema,
    tokens_display: z.strictObject({
      input: z.string(),
      output: z.string(),
      cache_read: z.string(),
      cache_write: z.string(),
    }),
    span_count: z.number().int(),
    span_types: z.array(z.string()),
    unclassified_reasons: z.array(z.string()).nullable(),
    unclassified_label: z.string().nullable(),
    pending_missing_token_types: z.array(tokenTypeSchema).nullable(),
    pending_missing_label: z.string().nullable(),
    costs: z.array(traceCostViewSchema).nullable(),
    costs_effective_from_display: z.string().nullable(),
    spans: z.array(spanViewSchema),
    content: traceContentViewSchema.nullable(),
  });

export type TraceListItemView = z.infer<typeof traceListItemSchema>;
export type TraceDetailView = z.infer<typeof traceDetailResponseSchema>;
