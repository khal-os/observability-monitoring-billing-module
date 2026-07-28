import {
  AgentRef,
  ChannelRef,
  ExperimentRef,
  SourceSpan,
  SourceTrace,
  TokenCounts,
} from '../../../application/interfaces/trace-source-client.js';
import { LangWatchApiSpan, LangWatchApiTrace } from './langwatch-api-schema.js';

// QA14 — mapeamento do payload real para o contrato T1. Convenções de
// metadata (a formalizar com os times de agentes e do omni); os fallbacks
// seguem o semconv de resources do OpenTelemetry, então componentes que
// emitem via OTel preenchem versão/instância de graça:
//   agente:  `agent` ∥ `service.name` · `agent.version` ∥ `service.version`
//            · `agent.instance` ∥ `service.instance.id`
//   canal:   `channel` (tipo: whatsapp/web/...) · `channel.version`
//            · `channel.instance` (deployment do omni que serviu o trace)
//   sessão = `thread_id`; `domain`/`subdomain` diretos.
//   usuário: `user_id` ∥ `langwatch.user.id` ∥ `user.id` (decisão 70)
//   ambiente: `deployment.environment` (∥ `.name`, o rename do semconv)
//   A/B:     `ab.experiment` + `ab.variant` (+ `ab.variant_version`)
// Fallbacks de token OpenInference NÃO existem aqui (decisão 72): a API
// expõe apenas `span.metrics` computadas, nunca attributes crus — a
// robustez extra vive só no adapter ClickHouse.

const metadataString = (
  metadata: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = metadata[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const metadataTokenCount = (
  metadata: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = metadata[key];
  const parsed =
    typeof value === 'string' ? Number.parseInt(value, 10) : Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const sumSpanMetric = (
  spans: LangWatchApiSpan[],
  metric:
    | 'prompt_tokens'
    | 'completion_tokens'
    | 'cache_read_input_tokens'
    | 'cache_creation_input_tokens',
): number | undefined => {
  let sum = 0;
  let found = false;

  for (const span of spans) {
    const value = span.metrics?.[metric];

    if (typeof value === 'number' && value > 0) {
      sum += value;
      found = true;
    }
  }

  return found ? sum : undefined;
};

const extractErrorMessage = (error: unknown): string | undefined => {
  if (error === null || error === undefined) return undefined;
  if (typeof error === 'string') return error;

  if (typeof error === 'object' && 'message' in error) {
    const { message } = error as { message?: unknown };

    if (typeof message === 'string') return message;
  }

  return JSON.stringify(error);
};

const cleanTokens = (tokens: TokenCounts): TokenCounts => {
  const cleaned: TokenCounts = {};

  for (const [tokenType, count] of Object.entries(tokens)) {
    if (typeof count === 'number' && count > 0) {
      cleaned[tokenType as keyof TokenCounts] = count;
    }
  }

  return cleaned;
};

/**
 * The trace-level model: the SINGLE distinct model of the llm spans.
 * Multi-model traces (real occurrence: claude-code agents mixing opus and
 * haiku in one trace) map to `undefined` — the trace lands as
 * pending_price/unclassified instead of being priced by the WRONG model.
 * Pricing multi-model traces span-by-span is a post-PoC product decision
 * (registered in the backlog with the QA14 findings).
 */
const singleModelOf = (spans: LangWatchApiSpan[]): string | undefined => {
  const models = new Set(
    spans
      .filter((span) => span.type === 'llm' && span.model)
      .map((span) => span.model as string),
  );

  return models.size === 1 ? [...models][0] : undefined;
};

const mapSpan = (span: LangWatchApiSpan): SourceSpan => {
  const startedAt = new Date(span.timestamps.started_at);
  const finishedAt = new Date(
    span.timestamps.finished_at ?? span.timestamps.started_at,
  );

  const tokens = cleanTokens({
    input: span.metrics?.prompt_tokens ?? undefined,
    output: span.metrics?.completion_tokens ?? undefined,
    cache_read: span.metrics?.cache_read_input_tokens ?? undefined,
    cache_write: span.metrics?.cache_creation_input_tokens ?? undefined,
  });

  return {
    spanId: span.span_id,
    type: span.type ?? 'span',
    name: span.name ?? span.model ?? span.type ?? 'span',
    startedAt,
    finishedAt,
    status: span.error ? 'error' : 'ok',
    errorMessage: extractErrorMessage(span.error),
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    input: span.input?.value,
    output: span.output?.value,
  };
};

export const mapApiTrace = (trace: LangWatchApiTrace): SourceTrace => {
  const metadata = trace.metadata ?? {};
  const spans = trace.spans ?? [];

  const startedAt = new Date(trace.timestamps.started_at);
  // A API não expõe finished_at de trace — deriva do total_time_ms (QA14).
  const finishedAt = new Date(
    trace.timestamps.started_at + (trace.metrics?.total_time_ms ?? 0),
  );

  const tokens = cleanTokens({
    input: trace.metrics?.prompt_tokens ?? sumSpanMetric(spans, 'prompt_tokens'),
    output:
      trace.metrics?.completion_tokens ??
      sumSpanMetric(spans, 'completion_tokens'),
    cache_read:
      metadataTokenCount(metadata, 'langwatch.reserved.cache_read_tokens') ??
      sumSpanMetric(spans, 'cache_read_input_tokens'),
    cache_write:
      metadataTokenCount(
        metadata,
        'langwatch.reserved.cache_creation_tokens',
      ) ?? sumSpanMetric(spans, 'cache_creation_input_tokens'),
  });

  const rootSpan = spans.find((span) => !span.parent_id);

  const agentId =
    metadataString(metadata, 'agent') ??
    metadataString(metadata, 'service.name');

  const agent: AgentRef | undefined = agentId
    ? {
        id: agentId,
        version:
          metadataString(metadata, 'agent.version') ??
          metadataString(metadata, 'service.version'),
        instance:
          metadataString(metadata, 'agent.instance') ??
          metadataString(metadata, 'service.instance.id'),
      }
    : undefined;

  const channel: ChannelRef = {
    type: metadataString(metadata, 'channel') ?? 'unknown',
    version: metadataString(metadata, 'channel.version'),
    instance: metadataString(metadata, 'channel.instance'),
  };

  const experimentName = metadataString(metadata, 'ab.experiment');
  const experimentVariant = metadataString(metadata, 'ab.variant');

  const experiment: ExperimentRef | undefined =
    experimentName && experimentVariant
      ? {
          name: experimentName,
          variant: experimentVariant,
          variantVersion: metadataString(metadata, 'ab.variant_version'),
        }
      : undefined;

  return {
    traceId: trace.trace_id,
    sessionId:
      metadataString(metadata, 'thread_id') ??
      metadataString(metadata, 'langwatch.thread.id'),
    userId:
      metadataString(metadata, 'user_id') ??
      metadataString(metadata, 'langwatch.user.id') ??
      metadataString(metadata, 'user.id'),
    agent,
    model: singleModelOf(spans),
    type: rootSpan?.type ?? 'unknown',
    channel,
    domain: metadataString(metadata, 'domain'),
    subdomain: metadataString(metadata, 'subdomain'),
    environment:
      metadataString(metadata, 'deployment.environment') ??
      metadataString(metadata, 'deployment.environment.name'),
    experiment,
    startedAt,
    finishedAt,
    status: trace.error ? 'error' : 'ok',
    tokens,
    input: trace.input?.value ?? null,
    output: trace.output?.value ?? null,
    spans: [...spans]
      .sort((a, b) => a.timestamps.started_at - b.timestamps.started_at)
      .map(mapSpan),
  };
};
