import {
  AgentRef,
  ChannelRef,
  ExperimentRef,
  SourceSpan,
  SourceTrace,
  TokenCounts,
} from '../../../../application/interfaces/trace-source-client.js';
import { CorruptTokenCount } from '../../token-salvage-gate.js';
import {
  SalvageableTokenField,
  SpanRow,
  SummaryRow,
} from './clickhouse-row-schema.js';

// decision 59 — maps LangWatch's raw ClickHouse rows to SourceTrace. The
// field translation mirrors what LangWatch's own HTTP API projects from
// these rows (verified at the time by fetching one trace through BOTH
// paths against the live 3.5.0 instance; the HTTP adapter itself was
// removed by decision 127 — ClickHouse is the only real source):
//   thread_id            ← Attributes['gen_ai.conversation.id']
//   input/output.value   ← ComputedInput / ComputedOutput
//   metrics.*_tokens     ← TotalPromptTokenCount / TotalCompletionTokenCount
//   span.type            ← SpanAttributes['langwatch.span.type']
//   span.metrics.*       ← SpanAttributes['gen_ai.usage.*'] (string ints)
//   span.model           ← gen_ai.response.model ∥ gen_ai.request.model
// Metadata conventions (agent/channel/domain) are the same as the API
// mapper; trace-level lookups fall back to the root span's
// ResourceAttributes, which is where OTel semconv resources land.
// Decision 70 adds display-only enrichment reads: user (user_id ∥
// langwatch.user.id ∥ user.id), environment (deployment.environment) and
// the A/B arm (ab.experiment/ab.variant/ab.variant_version). Decision 72
// adds defensive OpenInference cache-token fallbacks on spans
// (llm.token_count.prompt_details.*) for stacks whose keys LangWatch does
// not normalize to gen_ai.usage.*.

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
    cache_read:
      attributeTokenCount(row.attributes, 'gen_ai.usage.cache_read.input_tokens') ??
      attributeTokenCount(
        row.attributes,
        'llm.token_count.prompt_details.cache_read',
      ),
    cache_write:
      attributeTokenCount(
        row.attributes,
        'gen_ai.usage.cache_creation.input_tokens',
      ) ??
      attributeTokenCount(
        row.attributes,
        'llm.token_count.prompt_details.cache_write',
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
  const merged = { ...rootRow?.attributes, ...summary.attributes };

  // REST-collector traces store user metadata PREFIXED (metadata.agent,
  // metadata.channel, ...) while OTel traces use bare keys — the HTTP API
  // strips the prefix when serving. Mirror that: expose each metadata.*
  // entry under its bare name, explicit metadata winning over bare keys.
  const metadata: Record<string, string> = { ...merged };

  for (const [key, value] of Object.entries(merged)) {
    if (key.startsWith('metadata.')) {
      metadata[key.slice('metadata.'.length)] = value;
    }
  }

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

  const experimentName = attributeString(metadata, 'ab.experiment');
  const experimentVariant = attributeString(metadata, 'ab.variant');

  const experiment: ExperimentRef | undefined =
    experimentName && experimentVariant
      ? {
          name: experimentName,
          variant: experimentVariant,
          variantVersion: attributeString(metadata, 'ab.variant_version'),
        }
      : undefined;

  // The span fallback is also what decides the C-6.2 salvage: a count the
  // schema nulled (corrupt at the source) is only safe to proceed with
  // when THIS `?? sumSpanTokens(...)` rebuilds a real number for it —
  // see unreconstructedTokenCounts in token-salvage-gate.ts.
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
    userId:
      attributeString(metadata, 'user_id') ??
      attributeString(metadata, 'langwatch.user.id') ??
      attributeString(metadata, 'user.id'),
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
    environment:
      attributeString(metadata, 'deployment.environment') ??
      attributeString(metadata, 'deployment.environment.name'),
    experiment,
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

/**
 * The SourceTrace token type each salvageable summary count must land in
 * for a NULLED count to count as reconstructed.
 */
const SALVAGED_TOKEN_TYPE: Record<SalvageableTokenField, keyof TokenCounts> = {
  promptTokens: 'input',
  completionTokens: 'output',
};

/**
 * The counts `parseSummaryRow` nulled, in the vendor-neutral shape the
 * shared invariant-2 gate consumes (token-salvage-gate.ts). Only the
 * translation lives here — the RULE is one gate every source adapter
 * crosses (re-audit iteration 2), never a per-adapter copy.
 */
export const corruptTokenCounts = (
  nulledTokenFields: SalvageableTokenField[],
): CorruptTokenCount[] =>
  nulledTokenFields.map((field) => ({
    field,
    tokenType: SALVAGED_TOKEN_TYPE[field],
  }));
