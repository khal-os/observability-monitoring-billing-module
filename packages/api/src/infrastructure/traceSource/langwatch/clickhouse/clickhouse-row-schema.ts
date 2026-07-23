import { z } from 'zod';

// decision 59 — the sync reads LangWatch's OWN ClickHouse tables
// (trace_summaries + stored_spans) instead of the HTTP API: one SQL batch
// replaces search-pagination (capped at ~100) plus an N+1 detail GET per
// trace. The coupling to LangWatch's internal schema is pinned by the
// image tag in compose.client.yml and guarded at runtime by the
// goose_db_version tripwire in the client.
//
// These schemas validate the ROWS OF OUR OWN SELECTs (aliased columns,
// timestamps pre-converted to epoch ms via toUnixTimestamp64Milli — no
// server-timezone parsing anywhere). Like the API schema, they are
// deliberately tolerant: unknown extra columns must never break ingestion.
// A row that fails here is a poison row — skipped and logged, never fatal
// (decision 62).

/** Map(String, String) arrives as a plain JSON object. */
const attributesSchema = z.record(z.string(), z.string());

export const summaryRowSchema = z.looseObject({
  traceId: z.string().min(1),
  /** trace_summaries.OccurredAt — the trace's own start instant. */
  occurredAtMs: z.number(),
  /** trace_summaries.UpdatedAt — the CURSOR axis (source write time). */
  updatedAtMs: z.number(),
  attributes: attributesSchema,
  computedInput: z.string().nullable(),
  computedOutput: z.string().nullable(),
  totalDurationMs: z.number(),
  containsError: z.boolean(),
  errorMessage: z.string().nullable(),
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  rootSpanType: z.string().nullable(),
});

export const spanRowSchema = z.looseObject({
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  /** OTel status: 0 unset · 1 ok · 2 error. */
  statusCode: z.number().nullable(),
  statusMessage: z.string().nullable(),
  attributes: attributesSchema,
});

export type SummaryRow = z.infer<typeof summaryRowSchema>;
export type SpanRow = z.infer<typeof spanRowSchema>;
