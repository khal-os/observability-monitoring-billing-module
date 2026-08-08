import { z } from 'zod';
import { SessionListFilters } from './sessions-protocols.js';
import { isoDateParam } from '../../helpers/query-validation.js';

/** Shared by GET /sessions (plus pagination) and GET /sessions/filters. */
export const sessionFilterQueryShape = {
  from: isoDateParam.optional(),
  to: isoDateParam.optional(),
  agent: z.string().min(1).optional(),
  status: z.enum(['ok', 'error']).optional(),
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- exists only to derive the type below
const sessionFilterQuerySchema = z.strictObject(sessionFilterQueryShape);

export type SessionFilterQuery = z.infer<typeof sessionFilterQuerySchema>;

export const toSessionListFilters = (
  query: SessionFilterQuery,
): SessionListFilters => ({
  from: query.from,
  to: query.to,
  agentId: query.agent,
  status: query.status,
});
