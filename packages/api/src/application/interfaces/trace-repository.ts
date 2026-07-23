import {
  AgentRef,
  StampedTokenCost,
  TraceModel,
} from '../../domain/models/trace-model.js';
import { TokenType } from '../../domain/models/price-version-model.js';

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

  /** Refreshes attribution only — the price stamp is untouchable here. */
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

  /**
   * Refreshes the honesty companion of a STILL-pending trace: which token
   * types lack an effective price as of the latest evaluation (reprocess
   * shrinks the list as prices get registered). Guarded like the stamp:
   * writes only while pricingStatus is pending_price — never resurrects
   * pendingPrice on a stamped trace.
   */
  updatePendingPriceInfo(
    traceId: string,
    missingTokenTypes: TokenType[],
  ): Promise<void>;

  findPendingPrice(): Promise<TraceModel[]>;
}
