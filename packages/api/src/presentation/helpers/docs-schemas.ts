import { z } from 'zod';

/**
 * Shared response-contract schemas. Every response schema in the API is a
 * STRICT object: it is the same whitelist the view-models implement
 * (invariant 4 — internal fields absent by construction), stated once and
 * enforced twice — contract tests parse real responses with these schemas,
 * and the OpenAPI document is generated from them (single source of truth).
 */
export const apiErrorSchema = z.strictObject({
  name: z.string(),
  msg: z.string(),
});

export const paginatedSchema = <Item extends z.ZodType>(item: Item) =>
  z.strictObject({
    page: z.number().int(),
    page_size: z.number().int(),
    total: z.number().int(),
    total_pages: z.number().int(),
    items: z.array(item),
  });

export const tokenCountsViewSchema = z.strictObject({
  input: z.number().int(),
  output: z.number().int(),
  cache_read: z.number().int(),
  cache_write: z.number().int(),
});

export const executionStatusSchema = z.enum(['ok', 'error']);
export const pricingStatusSchema = z.enum(['stamped', 'pending_price']);
export const tokenTypeSchema = z.enum([
  'input',
  'output',
  'cache_read',
  'cache_write',
]);
