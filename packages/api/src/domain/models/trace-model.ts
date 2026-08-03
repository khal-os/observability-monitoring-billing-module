import { TokenType } from './price-version-model.js';
import { ModelRef } from './model-ref.js';
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
 * The A/B arm that served the execution — a POINT-IN-TIME fact denormalized
 * on the trace like AgentRef's version/instance, never resolved from the
 * experiment registry later. Display-only enrichment (decision 70): not a
 * filter, not a session key, not a billing dimension.
 */
export interface ExperimentRef {
  name: string;
  variant: string;
  variantVersion?: string;
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
  /** End user the execution served — display-only enrichment (decision 70). */
  userId?: string;
  agent?: AgentRef;
  /**
   * Structured internally (id + provider, parsed at ingestion); the wire
   * string is recomposed by `modelKey` at the borders.
   */
  model?: ModelRef;
  type: string;
  channel: ChannelRef;
  domain?: string;
  subdomain?: string;
  /** Deployment environment of the agent (dev/staging/prod) — display-only. */
  environment?: string;
  experiment?: ExperimentRef;
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
  /**
   * T6 post-close arrival: the trace is dated inside an ALREADY CLOSED
   * billing month. It is stored anyway (invariant 6 — the archive keeps
   * everything) but flagged: excluded from the frozen bill (which reads
   * the snapshot), blocked from pending-price stamping, visible to the
   * admin. A reopen makes the month live again — the flag stays as a
   * historical mark of the late arrival, and the re-close's reconciliation
   * marks it absorbed once a snapshot bills the trace (decision 100).
   */
  billingQuarantine?: {
    reason: 'period_closed';
    quarantinedAt: Date;
    /**
     * Decision 100 ("the snapshot adjudicates"): set by the post-close
     * reconciliation when a snapshot BILLED this flagged trace (the
     * reopen→re-close correction flow). Present ⇒ the quarantine is
     * resolved — the mark stays as history, but the trace is in the bill.
     */
    absorbedInSnapshotVersion?: number;
  } | null;
  /**
   * audit B-3 (Q8, approved): the ONE sanctioned dent in invariant 6's
   * "store everything" — a trace whose full document would breach the
   * store's ~16MB document cap is kept, with span/trace content replaced
   * by `{ truncated: true, originalBytes }` markers and this flag set.
   * Tokens, costs and the price stamp are NEVER affected (they come from
   * counts, not content), and the truncation event is recorded in
   * ingest_failures so the clipping is auditable. Absent on every
   * untouched trace.
   */
  contentTruncated?: boolean;
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
