import {
  AgentRef,
  StampedTokenCost,
  TokenCounts,
  TraceModel,
} from '../../domain/models/trace-model.js';

/**
 * The slim shape of the pending sweep (decision 79): exactly what
 * re-stamping needs. Full documents embed input/output/spans (decision
 * 47) — a day of unpriced traffic on a new model once meant loading
 * gigabytes of payloads into one array and OOM-ing the worker mid-incident.
 */
export interface PendingPriceTrace {
  traceId: string;
  model?: string;
  startedAt: Date;
  tokens: TokenCounts;
}

/**
 * Attribution fields are MUTABLE in open periods (invariant 7). This type
 * is the whole reason the update op exists: it structurally cannot carry
 * stamp/cost fields, so an attribution correction can never re-price.
 * (`model` is attribution for grouping purposes; a pending trace whose
 * model arrives later gets stamped by reprocess with the as-of rule.)
 * Fields left undefined keep their stored value — corrections made in the
 * store are never clobbered by a payload that lacks the field. The
 * `unclassified` flag is recomputed by the repository from the document
 * AFTER the merge, so flag and values can never contradict each other.
 */
export interface TraceAttribution {
  /** Replaced as a whole block when provided (id + version + instance). */
  agent?: AgentRef;
  model?: string;
  domain?: string;
  subdomain?: string;
}

export interface PendingStamp {
  stampedCosts: StampedTokenCost[];
  totalCostMicrocents: number;
  stampedAt: Date;
}

export interface TraceRepository {
  /**
   * Idempotent write keyed by the natural traceId: re-syncing a window can
   * never double-count, and an existing stamp is NEVER overwritten. One
   * trace = one document (decision 47), so the write is atomic.
   */
  insertIfAbsent(trace: TraceModel): Promise<'inserted' | 'skipped'>;

  /**
   * Refreshes attribution FROM THE SOURCE only — the price stamp is
   * untouchable here, and so is a runbook-corrected trace: a document
   * carrying `attributionCorrectedAt` (set by the open-period manual
   * correction, decision 79) is skipped whole. Without that guard, any
   * window re-sync — or the batch loop's own crash-replay — would quietly
   * revert a correction back to the source's stale value (the source
   * still holds the wrong attribution; that is WHY it was corrected).
   */
  updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<void>;

  /**
   * Stamps a pending_price trace. Guarded: writes ONLY while the trace is
   * still pending — a stamped trace is immutable (invariant 1).
   */
  stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
  ): Promise<'stamped' | 'skipped'>;

  /** Slim projection, oldest first — never the embedded payloads. */
  findPendingPrice(): Promise<PendingPriceTrace[]>;
}
