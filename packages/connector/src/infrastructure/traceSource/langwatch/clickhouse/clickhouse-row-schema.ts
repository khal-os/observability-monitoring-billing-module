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
  // Token counts must be whole and non-negative AT THE BOUNDARY: a
  // fractional or negative count reaching the stamper either throws
  // (assertNonNegativeInteger — a deterministic error the batch loop
  // would re-read forever) or mints a stamp inconsistent with its own
  // tokens. Tightening here routes such rows to the poison path
  // (decision 62) instead.
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),
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

/** The only fields the salvage rule may repair — never identity/timestamps. */
export type SalvageableTokenField = 'promptTokens' | 'completionTokens';

export type SummaryRowParse =
  | { ok: true; row: SummaryRow; nulledTokenFields: SalvageableTokenField[] }
  | { ok: false; error: string };

const SALVAGEABLE_TOKEN_FIELDS = new Set<SalvageableTokenField>([
  'promptTokens',
  'completionTokens',
]);

const isSalvageableTokenField = (
  field: string,
): field is SalvageableTokenField =>
  SALVAGEABLE_TOKEN_FIELDS.has(field as SalvageableTokenField);

/**
 * audit C-6.2 salvage rule — HALF of it. A summary row failing ONLY the
 * token-count refinement (negative/fractional counts — an instrumentation
 * defect, not schema drift) has the offending counts NULLED here and
 * returns them in `nulledTokenFields`; content and identity are preserved.
 *
 * Whether the row is then SALVAGED or stays POISON is deliberately NOT
 * decided here (audit iteration 1, invariant 2): nulling alone lets a
 * trace whose real usage is unknown reach the stamper with ZERO used
 * token types, where it is stamped R$ 0,00 IMMUTABLY — the one outcome
 * invariant 2 forbids, and one reprocess can never rescue (a trace with
 * no used token type has no missing price to wait for). The client
 * completes the rule after mapping: it salvages only when the span-level
 * `gen_ai.usage.*` sums reconstruct EVERY nulled count, and keeps the row
 * poison otherwise (durably recorded — a poison record beats a wrong
 * immutable stamp). Rows failing structurally (missing id/timestamps,
 * wrong shapes) remain poison regardless. This still removes the old
 * asymmetry where the same bad-token defect dropped the whole trace at
 * summary level but only the count at span level.
 */
export const parseSummaryRow = (raw: unknown): SummaryRowParse => {
  const parsed = summaryRowSchema.safeParse(raw);

  if (parsed.success) {
    return { ok: true, row: parsed.data, nulledTokenFields: [] };
  }

  const offendingFields = new Set(
    parsed.error.issues.map((issue) => String(issue.path[0])),
  );

  const salvageable =
    typeof raw === 'object' &&
    raw !== null &&
    [...offendingFields].every(isSalvageableTokenField);

  if (salvageable) {
    const retried = summaryRowSchema.safeParse({
      ...(raw as Record<string, unknown>),
      ...Object.fromEntries([...offendingFields].map((field) => [field, null])),
    });

    if (retried.success) {
      return {
        ok: true,
        row: retried.data,
        nulledTokenFields: [...offendingFields]
          .filter(isSalvageableTokenField)
          .sort(),
      };
    }
  }

  return { ok: false, error: parsed.error.message };
};
