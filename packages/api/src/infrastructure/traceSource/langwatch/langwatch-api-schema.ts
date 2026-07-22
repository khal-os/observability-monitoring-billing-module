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
      prompt_tokens: z.number().nullable().optional(),
      completion_tokens: z.number().nullable().optional(),
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
