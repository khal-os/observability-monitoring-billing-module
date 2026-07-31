import { z } from 'zod';
import { tokenTypeSchema } from '../../helpers/docs-schemas.js';

/**
 * Request contract of POST /prices (T4 write). STRICT on purpose: a typoed
 * optional key silently ignored is how a wrong price gets registered —
 * unknown fields are a 400, not a shrug. R$ only by construction
 * (invariant 4). Registration always declares a fixed R$ price
 * ('fixed_brl' — decision 96); a future computed pricing type (e.g.
 * USD × PTAX × markup) arrives as a NEW contract with its own declared
 * inputs, never as extra optional fields here.
 *
 * Money arrives as a DECIMAL STRING (never a JSON float — the same "never
 * float" rule as storage): up to 8 decimal places, converted to integer µ¢
 * at this border.
 */
export const registerPriceVersionRequestSchema = z.strictObject({
  model: z.string().min(1),
  token_type: tokenTypeSchema,
  price_brl_per_million: z
    .string()
    .regex(/^\d+(\.\d{1,8})?$/, 'decimal string, e.g. "2.75"'),
  effective_from: z
    .union([z.iso.date(), z.iso.datetime({ offset: true, local: true })])
    .transform((value) => new Date(value))
    .refine((date) => !Number.isNaN(date.getTime())),
});

export const registerPriceVersionResponseSchema = z.strictObject({
  model: z.string(),
  token_type: tokenTypeSchema,
  price_brl_per_million: z.string(),
  price_display: z.string(),
  effective_from: z.string(),
  effective_from_display: z.string(),
  // Decision 57: what the new price immediately unblocked.
  reprocess: z.strictObject({
    examined: z.number().int(),
    stamped: z.number().int(),
    still_pending: z.number().int(),
    failed: z.number().int(),
    /** T6: pending traces of CLOSED months — untouched until an audited reopen. */
    blocked_closed_month: z.number().int(),
  }),
});

export type RegisterPriceVersionRequest = z.infer<
  typeof registerPriceVersionRequestSchema
>;
export type RegisterPriceVersionResponse = z.infer<
  typeof registerPriceVersionResponseSchema
>;
