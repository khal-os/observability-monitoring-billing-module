import { z } from 'zod';
import { TraceListFilters } from './traces-protocols.js';
import { isoDateParam } from '../../helpers/query-validation.js';

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
  from: isoDateParam.optional(),
  to: isoDateParam.optional(),
  agent: stringListParam,
  status: z.enum(['ok', 'error']).optional(),
  type: stringListParam,
  channel: stringListParam,
  domain: stringListParam,
  subdomain: stringListParam,
  search: z.string().min(1).optional(),
  // audit D-9: the bill's quarantined_trace_count finally links to rows.
  quarantined: z.enum(['true', 'false']).optional(),
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- exists only to derive the type below
const traceFilterQuerySchema = z.strictObject(traceFilterQueryShape);

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
  quarantined:
    query.quarantined === undefined ? undefined : query.quarantined === 'true',
});
