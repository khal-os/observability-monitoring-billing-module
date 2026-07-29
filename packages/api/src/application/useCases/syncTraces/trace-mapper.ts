import { SourceTrace } from '../../interfaces/trace-source-client.js';
import { TraceModel, UnclassifiedInfo } from '../../../domain/models/trace-model.js';
import { ModelRef, parseModelRef } from '../../../domain/models/model-ref.js';
import { SpanModel } from '../../../domain/models/span-model.js';
import { StampOutcome } from './price-stamper.js';

/**
 * THE single definition of the unclassified rule (T3): identity is the
 * agent id; version/instance are optional enrichment and never unclassify
 * a trace. Exported so repository adapters that recompute the flag after
 * an attribution merge use the exact same conditions and reason strings —
 * never a hand-copied duplicate.
 */
export const deriveUnclassified = (args: {
  agentId: string | undefined;
  model: ModelRef | undefined;
}): UnclassifiedInfo | undefined => {
  const reasons: string[] = [];

  if (!args.agentId) {
    reasons.push('missing agentId');
  }

  if (!args.model) {
    reasons.push('missing model');
  }

  return reasons.length > 0 ? { reasons } : undefined;
};

/**
 * Missing/invalid attribution never drops a trace — it is stored and
 * flagged unclassified with the reasons (T3), attribution stays mutable.
 */
/**
 * The ONE point where the source's loose model string becomes the
 * structured domain ref — everything past ingestion carries the object.
 */
export const sourceModelRef = (trace: SourceTrace): ModelRef | undefined =>
  trace.model ? parseModelRef(trace.model) : undefined;

export const classifyAttribution = (
  trace: SourceTrace,
): UnclassifiedInfo | undefined =>
  deriveUnclassified({ agentId: trace.agent?.id, model: sourceModelRef(trace) });

/**
 * Canonical shapes for storage: every optional key is NAMED here (agent
 * and channel blocks always carry id/type + version + instance; token
 * counts always carry the four types). Undefined values become null at the
 * write boundary, so stored documents always show the full schema.
 */
const canonicalTokens = (tokens: SourceTrace['tokens']) => ({
  input: tokens.input,
  output: tokens.output,
  cache_read: tokens.cache_read,
  cache_write: tokens.cache_write,
});

/** Derived-at-write consolidation (decision 51): total across ALL token types. */
export const sumTokens = (tokens: SourceTrace['tokens']): number =>
  (tokens.input ?? 0) +
  (tokens.output ?? 0) +
  (tokens.cache_read ?? 0) +
  (tokens.cache_write ?? 0);

export const mapToTrace = (
  trace: SourceTrace,
  stamp: StampOutcome,
  ingestedAt: Date,
): TraceModel => {
  const spans: SpanModel[] = [...trace.spans]
    .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
    .map((span) => ({
      spanId: span.spanId,
      type: span.type,
      name: span.name,
      startedAt: span.startedAt,
      finishedAt: span.finishedAt,
      // Clock skew between source hosts can yield finished < started;
      // the stored snapshot is canonical, so clamp at the write boundary.
      durationMs: Math.max(
        span.finishedAt.getTime() - span.startedAt.getTime(),
        0,
      ),
      offsetMs: span.startedAt.getTime() - trace.startedAt.getTime(),
      status: span.status,
      errorMessage: span.errorMessage,
      tokens: span.tokens ? canonicalTokens(span.tokens) : undefined,
      input: span.input,
      output: span.output,
    }));

  const traceModel: TraceModel = {
    traceId: trace.traceId,
    sessionId: trace.sessionId,
    userId: trace.userId,
    agent: trace.agent
      ? {
          id: trace.agent.id,
          version: trace.agent.version,
          instance: trace.agent.instance,
        }
      : undefined,
    model: sourceModelRef(trace),
    type: trace.type,
    channel: {
      type: trace.channel.type,
      version: trace.channel.version,
      instance: trace.channel.instance,
    },
    domain: trace.domain,
    subdomain: trace.subdomain,
    environment: trace.environment,
    experiment: trace.experiment
      ? {
          name: trace.experiment.name,
          variant: trace.experiment.variant,
          variantVersion: trace.experiment.variantVersion,
        }
      : undefined,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
    durationMs: Math.max(
      trace.finishedAt.getTime() - trace.startedAt.getTime(),
      0,
    ),
    status: trace.status,
    tokens: canonicalTokens(trace.tokens),
    tokensTotal: sumTokens(trace.tokens),
    pricingStatus: stamp.pricingStatus,
    stampedCosts:
      stamp.pricingStatus === 'stamped' ? stamp.stampedCosts : undefined,
    totalCostMicrocents:
      stamp.pricingStatus === 'stamped' ? stamp.totalCostMicrocents : undefined,
    stampedAt: stamp.pricingStatus === 'stamped' ? ingestedAt : undefined,
    // NOT consolidated (the deliberate exception to decision 51): the
    // missing-types honesty depends on the MUTABLE price table, so it is
    // derived at read time (queryTraces/derive-pending-price.ts) — a stored
    // copy would go stale the moment a price is registered.
    pendingPrice: undefined,
    unclassified: classifyAttribution(trace),
    ingestedAt,
    input: trace.input,
    output: trace.output,
    spans,
  };

  return traceModel;
};
