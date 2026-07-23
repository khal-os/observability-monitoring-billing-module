import {
  AgentRef,
  ChannelRef,
  SourceSpan,
  SourceTrace,
  TokenCounts,
} from '../../../../application/interfaces/trace-source-client.js';
import { SpanRow, SummaryRow } from './clickhouse-row-schema.js';

// decision 59 — raw-row counterpart of langwatch-api-mapper.ts. The API is
// itself a projection of these rows; this mapper replicates the same
// translation (verified by fetching one trace through BOTH paths against
// the live 3.5.0 instance), so either source yields the same SourceTrace:
//   thread_id            ← Attributes['gen_ai.conversation.id']
//   input/output.value   ← ComputedInput / ComputedOutput
//   metrics.*_tokens     ← TotalPromptTokenCount / TotalCompletionTokenCount
//   span.type            ← SpanAttributes['langwatch.span.type']
//   span.metrics.*       ← SpanAttributes['gen_ai.usage.*'] (string ints)
//   span.model           ← gen_ai.response.model ∥ gen_ai.request.model
// Metadata conventions (agent/channel/domain) are the same as the API
// mapper; trace-level lookups fall back to the root span's
// ResourceAttributes, which is where OTel semconv resources land.

const attributeString = (
  attributes: Record<string, string>,
  key: string,
): string | undefined => {
  const value = attributes[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const attributeTokenCount = (
  attributes: Record<string, string>,
  key: string,
): number | undefined => {
  const value = attributes[key];

  if (value === undefined) return undefined;

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const sumSpanTokens = (
  spans: SourceSpan[],
  tokenType: keyof TokenCounts,
): number | undefined => {
  let sum = 0;
  let found = false;

  for (const span of spans) {
    const value = span.tokens?.[tokenType];

    if (typeof value === 'number' && value > 0) {
      sum += value;
      found = true;
    }
  }

  return found ? sum : undefined;
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

const spanModel = (span: SpanRow): string | undefined =>
  attributeString(span.attributes, 'gen_ai.response.model') ??
  attributeString(span.attributes, 'gen_ai.request.model');

/**
 * Same rule as the API mapper: the SINGLE distinct model of the llm spans;
 * multi-model traces map to undefined (pending_price/unclassified) instead
 * of being priced by the wrong model.
 */
const singleModelOf = (spans: SpanRow[]): string | undefined => {
  const models = new Set(
    spans
      .filter(
        (span) =>
          attributeString(span.attributes, 'langwatch.span.type') === 'llm' &&
          spanModel(span),
      )
      .map((span) => spanModel(span) as string),
  );

  return models.size === 1 ? [...models][0] : undefined;
};

/**
 * langwatch.input/output are strings; the declared type sits in
 * langwatch.reserved.value_types. Fidelity rule (verified by diffing one
 * trace stored via both paths — the API's span content behavior):
 *   · declared `=json`          → the API serves the PARSED value
 *   · chat_messages (an output
 *     with gen_ai.output.messages present) → the API serves the RAW string
 *   · `=text` / undeclared      → raw string
 */
const spanContent = (
  attributes: Record<string, string>,
  key: 'langwatch.input' | 'langwatch.output',
): unknown => {
  const raw = attributes[key];

  if (raw === undefined) return undefined;

  if (
    key === 'langwatch.output' &&
    attributes['gen_ai.output.messages'] !== undefined
  ) {
    return raw; // chat_messages: the API keeps these raw
  }

  const declaredTypes = attributes['langwatch.reserved.value_types'];

  if (declaredTypes !== undefined && declaredTypes.includes(`${key}=json`)) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  return raw;
};

const mapSpan = (row: SpanRow): SourceSpan => {
  const tokens = cleanTokens({
    input: attributeTokenCount(row.attributes, 'gen_ai.usage.input_tokens'),
    output: attributeTokenCount(row.attributes, 'gen_ai.usage.output_tokens'),
    cache_read: attributeTokenCount(
      row.attributes,
      'gen_ai.usage.cache_read.input_tokens',
    ),
    cache_write: attributeTokenCount(
      row.attributes,
      'gen_ai.usage.cache_creation.input_tokens',
    ),
  });

  return {
    spanId: row.spanId,
    type: attributeString(row.attributes, 'langwatch.span.type') ?? 'span',
    name: row.name.length > 0 ? row.name : (spanModel(row) ?? 'span'),
    startedAt: new Date(row.startedAtMs),
    finishedAt: new Date(Math.max(row.endedAtMs, row.startedAtMs)),
    status: row.statusCode === 2 ? 'error' : 'ok',
    errorMessage:
      row.statusCode === 2 ? (row.statusMessage ?? 'error') : undefined,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    input: spanContent(row.attributes, 'langwatch.input'),
    output: spanContent(row.attributes, 'langwatch.output'),
  };
};

export const mapSummaryTrace = (
  summary: SummaryRow,
  spanRows: SpanRow[],
): SourceTrace => {
  const sorted = [...spanRows].sort((a, b) => a.startedAtMs - b.startedAtMs);
  const rootRow = sorted.find((row) => row.parentSpanId === null);
  const spans = sorted.map(mapSpan);

  // Trace-level metadata lives in the summary's Attributes; OTel resource
  // keys (service.version, service.instance.id, ...) only exist on span
  // attributes (the SELECT folds ResourceAttributes into each span row) —
  // merge the root span's under the summary's, summary wins on conflicts.
  const metadata = { ...rootRow?.attributes, ...summary.attributes };

  const agentId =
    attributeString(metadata, 'agent') ??
    attributeString(metadata, 'service.name');

  const agent: AgentRef | undefined = agentId
    ? {
        id: agentId,
        version:
          attributeString(metadata, 'agent.version') ??
          attributeString(metadata, 'service.version'),
        instance:
          attributeString(metadata, 'agent.instance') ??
          attributeString(metadata, 'service.instance.id'),
      }
    : undefined;

  const channel: ChannelRef = {
    type: attributeString(metadata, 'channel') ?? 'unknown',
    version: attributeString(metadata, 'channel.version'),
    instance: attributeString(metadata, 'channel.instance'),
  };

  const tokens = cleanTokens({
    input: summary.promptTokens ?? sumSpanTokens(spans, 'input'),
    output: summary.completionTokens ?? sumSpanTokens(spans, 'output'),
    cache_read:
      attributeTokenCount(metadata, 'langwatch.reserved.cache_read_tokens') ??
      sumSpanTokens(spans, 'cache_read'),
    cache_write:
      attributeTokenCount(
        metadata,
        'langwatch.reserved.cache_creation_tokens',
      ) ?? sumSpanTokens(spans, 'cache_write'),
  });

  const startedAt = new Date(summary.occurredAtMs);

  return {
    traceId: summary.traceId,
    sessionId:
      attributeString(metadata, 'gen_ai.conversation.id') ??
      attributeString(metadata, 'thread_id') ??
      attributeString(metadata, 'langwatch.thread.id'),
    agent,
    model: singleModelOf(spanRows),
    type:
      summary.rootSpanType ??
      (rootRow
        ? attributeString(rootRow.attributes, 'langwatch.span.type')
        : undefined) ??
      'unknown',
    channel,
    domain: attributeString(metadata, 'domain'),
    subdomain: attributeString(metadata, 'subdomain'),
    startedAt,
    finishedAt: new Date(
      summary.occurredAtMs + Math.max(summary.totalDurationMs, 0),
    ),
    status: summary.containsError ? 'error' : 'ok',
    tokens,
    input: summary.computedInput,
    output: summary.computedOutput,
    spans,
  };
};
