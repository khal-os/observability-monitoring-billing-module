import { z } from 'zod';

// QA14 — RESOLVIDO (sondagem da instância self-hosted em 2026-07-20):
// shapes observados na API real. Pontos que moldaram este schema:
// - `POST /api/traces/search` pagina com pageSize/pageOffset e devolve
//   `pagination.totalHits`; os itens vêm com `spans: []` — os spans SÓ
//   existem em `GET /api/traces/{id}?format=json` (busca é N+1).
// - Timestamps são epoch em MILISSEGUNDOS; o trace NÃO tem finished_at
//   (deriva-se de started_at + metrics.total_time_ms).
// - Tokens de cache vêm como STRINGS em
//   metadata["langwatch.reserved.cache_read_tokens"/"cache_creation_tokens"]
//   e/ou como números em span.metrics.cache_read_input_tokens/
//   cache_creation_input_tokens.
// - Metadata carrega thread_id (sessão), user_id, customer_id e chaves
//   livres (agent, domain, subdomain, service.name, ...).
// O schema é deliberadamente tolerante (passthrough) — campos novos da
// plataforma não podem quebrar a ingestão.

const apiContentSchema = z
  .looseObject({ value: z.unknown() })
  .nullable()
  .optional();

const apiSpanSchema = z.looseObject({
  span_id: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  input: apiContentSchema,
  output: apiContentSchema,
  error: z.unknown().nullable().optional(),
  timestamps: z.looseObject({
    started_at: z.number(),
    finished_at: z.number().nullable().optional(),
  }),
  metrics: z
    .looseObject({
      prompt_tokens: z.number().nullable().optional(),
      completion_tokens: z.number().nullable().optional(),
      cache_read_input_tokens: z.number().nullable().optional(),
      cache_creation_input_tokens: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export const langWatchApiTraceSchema = z.looseObject({
  trace_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  timestamps: z.looseObject({ started_at: z.number() }),
  metrics: z
    .looseObject({
      total_time_ms: z.number().nullable().optional(),
      // Trace-level counts must be whole and non-negative AT THE BOUNDARY,
      // exactly like the raw-row schema: a fractional or negative count
      // reaching the stamper either throws (assertNonNegativeInteger) or
      // mints a stamp inconsistent with its own tokens. Failing here routes
      // the detail through the nulls-and-reports salvage path below.
      prompt_tokens: z.number().int().nonnegative().nullable().optional(),
      completion_tokens: z.number().int().nonnegative().nullable().optional(),
    })
    .nullable()
    .optional(),
  error: z.unknown().nullable().optional(),
  input: apiContentSchema,
  output: apiContentSchema,
  spans: z.array(apiSpanSchema).optional(),
});

export const langWatchSearchResponseSchema = z.looseObject({
  traces: z.array(z.looseObject({ trace_id: z.string().min(1) })),
  pagination: z
    .looseObject({ totalHits: z.number().optional() })
    .nullable()
    .optional(),
});

export type LangWatchApiTrace = z.infer<typeof langWatchApiTraceSchema>;
export type LangWatchApiSpan = z.infer<typeof apiSpanSchema>;

/** The only fields the salvage rule may repair — never identity/timestamps. */
export type SalvageableMetricField = 'prompt_tokens' | 'completion_tokens';

export type ApiTraceParse =
  | {
      ok: true;
      trace: LangWatchApiTrace;
      nulledTokenFields: SalvageableMetricField[];
    }
  | { ok: false; error: string };

const SALVAGEABLE_METRIC_PATHS = new Map<string, SalvageableMetricField>([
  ['metrics.prompt_tokens', 'prompt_tokens'],
  ['metrics.completion_tokens', 'completion_tokens'],
]);

/**
 * Salvage rule at the detail boundary — HALF of it, the twin of
 * `parseSummaryRow` on the raw-row path (re-audit iteration 2, invariant
 * 2). A detail failing ONLY the trace-level token refinement (negative or
 * fractional counts — an instrumentation defect, not schema drift) has the
 * offending counts NULLED here and returns them in `nulledTokenFields`;
 * content and identity are preserved. Nulling is what lets the mapper's
 * `?? sumSpanMetric(...)` fallback fire at all — a PRESENT-but-invalid
 * count would otherwise be consumed by the `??` and silently dropped.
 *
 * Whether the detail is then SALVAGED or stays POISON is deliberately NOT
 * decided here: that is the shared invariant-2 gate (token-salvage-gate),
 * which lets the trace through only when the span-level usage sums rebuilt
 * every nulled count. Details failing structurally (missing id/timestamps,
 * wrong shapes) remain poison regardless.
 */
export const parseApiTrace = (raw: unknown): ApiTraceParse => {
  const parsed = langWatchApiTraceSchema.safeParse(raw);

  if (parsed.success) {
    return { ok: true, trace: parsed.data, nulledTokenFields: [] };
  }

  const offendingPaths = new Set(
    parsed.error.issues.map((issue) => issue.path.join('.')),
  );

  const salvageable =
    typeof raw === 'object' &&
    raw !== null &&
    [...offendingPaths].every((path) => SALVAGEABLE_METRIC_PATHS.has(path));

  if (salvageable) {
    const nulledTokenFields = [...offendingPaths].map(
      (path) => SALVAGEABLE_METRIC_PATHS.get(path) as SalvageableMetricField,
    );
    const source = raw as { metrics?: Record<string, unknown> };
    const retried = langWatchApiTraceSchema.safeParse({
      ...(raw as Record<string, unknown>),
      metrics: {
        ...source.metrics,
        ...Object.fromEntries(nulledTokenFields.map((field) => [field, null])),
      },
    });

    if (retried.success) {
      return {
        ok: true,
        trace: retried.data,
        nulledTokenFields: nulledTokenFields.sort(),
      };
    }
  }

  return { ok: false, error: parsed.error.message };
};
