import { TokenType } from './price-version-model.js';
import { SpanModel } from './span-model.js';

export type ExecutionStatus = 'ok' | 'error';

export type TokenCounts = Partial<Record<TokenType, number>>;

/**
 * Pricing state is ORTHOGONAL to execution status (T1 status is ok/error;
 * T10 filters by it). A pending_price trace keeps its tokens, has NO cost
 * fields at all — it is never valued at R$ 0.00 (invariant 2).
 */
export type PricingStatus = 'stamped' | 'pending_price';

/**
 * Agents and the omni channel both scale horizontally and deploy in
 * versions. `version` (build that handled the trace) and `instance`
 * (replica that handled it) are POINT-IN-TIME facts of the execution —
 * denormalized on each trace like the price stamp, never resolved from a
 * registry that changes over time. `id`/`type` remain the identity used
 * by filters, sessions and billing; version/instance are optional
 * enrichment (their absence never unclassifies a trace).
 */
export interface AgentRef {
  id: string;
  version?: string;
  instance?: string;
}

export interface ChannelRef {
  /** Communication channel (whatsapp/web/... — voice arrives here later). */
  type: string;
  /** Omni deployment that served the trace. */
  version?: string;
  instance?: string;
}

/**
 * The price stamp (T5): applied price + resulting cost per token type,
 * written at ingestion time and IMMUTABLE from then on (invariant 1).
 */
export interface StampedTokenCost {
  tokenType: TokenType;
  tokens: number;
  appliedPriceMicrocentsPerMillion: number;
  appliedPriceEffectiveFrom: Date;
  costMicrocents: number;
}

export interface UnclassifiedInfo {
  reasons: string[];
}

/**
 * Honesty companion of pending_price (US3): WHICH token types currently
 * lack an effective price. DERIVED AT READ TIME (the deliberate exception
 * to decision 51 — its truth depends on the mutable price table, so a
 * stored copy would go stale the moment a price is registered). Never
 * persisted: sync writes null, the read use cases compute it fresh via
 * queryTraces/derive-pending-price.ts. Absent on stamped traces.
 */
export interface PendingPriceInfo {
  missingTokenTypes: TokenType[];
}

export interface TraceModel {
  traceId: string;
  sessionId?: string;
  agent?: AgentRef;
  model?: string;
  type: string;
  channel: ChannelRef;
  domain?: string;
  subdomain?: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  status: ExecutionStatus;
  tokens: TokenCounts;
  /**
   * Consolidated at ingestion (decision 51): traces are immutable
   * snapshots, so derived fields are computed once at write time — never
   * re-derived by readers. Sum of ALL token types.
   */
  tokensTotal: number;
  pricingStatus: PricingStatus;
  /** Present iff pricingStatus === 'stamped'. */
  stampedCosts?: StampedTokenCost[];
  /** Present iff pricingStatus === 'stamped'. Never 0-defaulted while pending. */
  totalCostMicrocents?: number;
  stampedAt?: Date;
  /** Present iff pricingStatus === 'pending_price' (as of ingestion). */
  pendingPrice?: PendingPriceInfo;
  /** Missing/invalid attribution metadata — stored and flagged, never dropped (T3). */
  unclassified?: UnclassifiedInfo;
  ingestedAt: Date;
  /**
   * Full payloads + ordered steps, merged into the trace document
   * (decision 47): one trace = one self-contained document, atomic writes,
   * single-read detail. Hot reads (lists, session chain, billing) MUST
   * project these fields out; revisit the merge if QA15 sizing shows the
   * aggregation working set hurting.
   */
  input: unknown;
  output: unknown;
  spans: SpanModel[];
}
