import { z } from 'zod';
import {
  executionStatusSchema,
  paginatedSchema,
} from '../../helpers/docs-schemas.js';
import { traceListItemSchema } from '../traces/trace-view-schemas.js';

/**
 * Display fields (`*_display`, `*_label`) are part of the contract
 * (decision 51): sessions are a DERIVED read-model, so aggregates and
 * their display projections are computed at query time — never stored.
 */
export const sessionListItemSchema = z.strictObject({
  session_id: z.string(),
  user_id: z.string().nullable(),
  agent: z.strictObject({
    id: z.string().nullable(),
    version: z.string().nullable(),
    instance: z.string().nullable(),
  }),
  agent_label: z.string(),
  domain: z.string().nullable(),
  subdomain: z.string().nullable(),
  scope_label: z.string().nullable(),
  trace_count: z.number().int(),
  status: executionStatusSchema,
  total_duration_ms: z.number().int(),
  total_duration_display: z.string(),
  tokens_in: z.number().int(),
  tokens_in_display: z.string(),
  tokens_out: z.number().int(),
  tokens_out_display: z.string(),
  tokens_total: z.number().int(),
  tokens_total_display: z.string(),
  pending_price_count: z.number().int(),
  cost_brl: z.string().nullable(),
  cost_brl_display: z.string().nullable(),
  stamped_cost_brl_partial: z.string().nullable(),
  stamped_cost_brl_partial_display: z.string().nullable(),
  started_at: z.string(),
  started_at_display: z.string(),
  last_activity_at: z.string(),
  last_activity_at_display: z.string(),
  age_display: z.string(),
});

/**
 * Sessions carry the same capped-total contract as traces (decision
 * 77/79): counting the grouped set stops at the cap and displays carry a
 * trailing "+".
 */
export const sessionListResponseSchema = paginatedSchema(
  sessionListItemSchema,
).extend({
  total_capped: z.boolean(),
  total_display: z.string(),
  total_pages_display: z.string(),
});

export const sessionDetailResponseSchema = sessionListItemSchema.extend({
  /** True when the chain was cut at the read bound (decision 79). */
  chain_truncated: z.boolean(),
  chain: z.array(
    traceListItemSchema.extend({
      input: z.unknown(),
      output: z.unknown(),
      input_text: z.string().nullable(),
      output_text: z.string().nullable(),
    }),
  ),
});

const sessionFilterOptionSchema = z.strictObject({
  value: z.string(),
  count: z.number().int(),
});

/** GET /sessions/filters — dropdown options counted over the read-model (decision 80). */
export const sessionFilterOptionsResponseSchema = z.strictObject({
  agents: z.array(sessionFilterOptionSchema),
  statuses: z.array(sessionFilterOptionSchema),
});

export type SessionListItemView = z.infer<typeof sessionListItemSchema>;
export type SessionDetailView = z.infer<typeof sessionDetailResponseSchema>;
