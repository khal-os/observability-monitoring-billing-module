import { z } from 'zod';

// Schema of the SOURCE CONTRACT (T1) used to validate the fake client's
// fixtures at the ingestion boundary. Timestamps are ISO strings on the
// wire and are COERCED to Date here — only BSON Dates may ever reach the
// store (string×Date comparisons in MongoDB match nothing, silently).

const tokenCountsSchema = z
  .object({
    input: z.number().int().nonnegative().optional(),
    output: z.number().int().nonnegative().optional(),
    cache_read: z.number().int().nonnegative().optional(),
    cache_write: z.number().int().nonnegative().optional(),
  })
  .strict();

const spanSchema = z
  .object({
    spanId: z.string().min(1),
    type: z.string().min(1),
    name: z.string().min(1),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date(),
    status: z.enum(['ok', 'error']),
    errorMessage: z.string().optional(),
    tokens: tokenCountsSchema.optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .strict();

const agentRefSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
    instance: z.string().min(1).optional(),
  })
  .strict();

const channelRefSchema = z
  .object({
    type: z.string().min(1),
    version: z.string().min(1).optional(),
    instance: z.string().min(1).optional(),
  })
  .strict();

export const sourceTraceSchema = z
  .object({
    traceId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    agent: agentRefSchema.optional(),
    model: z.string().min(1).optional(),
    type: z.string().min(1),
    channel: channelRefSchema,
    domain: z.string().optional(),
    subdomain: z.string().optional(),
    startedAt: z.coerce.date(),
    finishedAt: z.coerce.date(),
    status: z.enum(['ok', 'error']),
    tokens: tokenCountsSchema,
    input: z.unknown(),
    output: z.unknown(),
    spans: z.array(spanSchema),
  })
  .strict();

export const sourceTraceListSchema = z.array(sourceTraceSchema);
