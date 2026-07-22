import { z } from 'zod';
import {
  tokenCountsViewSchema,
  tokenTypeSchema,
} from '../../helpers/docs-schemas.js';

const billingLineSchema = z.strictObject({
  agent_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  model: z.string().nullable(),
  model_label: z.string(),
  token_type: tokenTypeSchema,
  tokens: z.number().int(),
  tokens_display: z.string(),
  cost_brl_exact: z.string(),
  cost_brl_exact_display: z.string(),
  cost_brl_display: z.string(),
  cost_brl_display_brl: z.string(),
});

/**
 * Bar geometry is API-computed (decision 51): segment widths are percents
 * of the full track, where the most expensive agent spans 100%. The
 * front-end lays segments out sequentially — zero client-side math.
 */
const billingAgentSegmentSchema = z.strictObject({
  token_type: tokenTypeSchema,
  width_percent: z.number(),
  label: z.string(),
});

const billingAgentGroupSchema = z.strictObject({
  agent_id: z.string().nullable(),
  agent_version: z.string().nullable(),
  agent_label: z.string(),
  version_label: z.string().nullable(),
  tokens_total: z.number().int(),
  tokens_total_display: z.string(),
  cost_brl_display: z.string(),
  bar_width_percent: z.number(),
  segments: z.array(billingAgentSegmentSchema),
  lines: z.array(billingLineSchema),
});

export const billingSummaryResponseSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  month_label: z.string(),
  period_status: z.enum(['in_progress', 'open']),
  partial: z.boolean(),
  total_cost_brl: z.string(),
  total_cost_brl_display: z.string(),
  stamped_tokens_total: z.number().int(),
  stamped_tokens_total_display: z.string(),
  agent_count: z.number().int(),
  model_count: z.number().int(),
  lines: z.array(billingLineSchema),
  agents: z.array(billingAgentGroupSchema),
  pending_price: z.strictObject({
    trace_count: z.number().int(),
    tokens: tokenCountsViewSchema,
    tokens_total: z.number().int(),
    tokens_total_display: z.string(),
    models: z.array(z.string()),
    models_label: z.string(),
  }),
});

export type BillingSummaryView = z.infer<typeof billingSummaryResponseSchema>;

export const billListItemSchema = z.strictObject({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  month_label: z.string(),
  period_status: z.enum(['in_progress', 'open']),
  partial: z.boolean(),
  status_label: z.string(),
  total_cost_brl: z.string(),
  total_cost_brl_display: z.string(),
  stamped_trace_count: z.number().int(),
  pending_trace_count: z.number().int(),
  tokens: z.number().int(),
  tokens_display: z.string(),
});

export const billListResponseSchema = z.strictObject({
  bills: z.array(billListItemSchema),
});

export type BillListView = z.infer<typeof billListResponseSchema>;
