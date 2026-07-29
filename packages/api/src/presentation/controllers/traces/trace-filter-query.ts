import { z } from 'zod';
import { TraceListFilters } from './traces-protocols.js';

/**
 * Multi-value filters arrive as repeated query params (?agent=a&agent=b):
 * Express's qs parser delivers those as arrays, while a single occurrence
 * stays a plain string — both normalize to a non-empty list. Semantics:
 * OR within a field, AND across fields (decision 76).
 */
const stringListParam = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]))
  .optional();

/** Shared by GET /traces (plus pagination) and GET /traces/filters. */
export const traceFilterQueryShape = {
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  agent: stringListParam,
  status: z.enum(['ok', 'error']).optional(),
  type: stringListParam,
  channel: stringListParam,
  domain: stringListParam,
  subdomain: stringListParam,
  search: z.string().min(1).optional(),
};

const traceFilterQuerySchema = z.object(traceFilterQueryShape);

export type TraceFilterQuery = z.infer<typeof traceFilterQuerySchema>;

export const toTraceListFilters = (
  query: TraceFilterQuery,
): TraceListFilters => ({
  from: query.from,
  to: query.to,
  agentIds: query.agent,
  status: query.status,
  types: query.type,
  channels: query.channel,
  domains: query.domain,
  subdomains: query.subdomain,
  search: query.search,
});
