import {
  AgentRef,
  StampedTokenCost,
  TokenCounts,
  TraceModel,
} from '../../domain/models/trace-model.js';
import { ModelRef } from '../../domain/models/model-ref.js';

/**
 * The slim shape of the pending sweep (decision 79): exactly what
 * re-stamping needs. Full documents embed input/output/spans (decision
 * 47) — a day of unpriced traffic on a new model once meant loading
 * gigabytes of payloads into one array and OOM-ing the worker mid-incident.
 */
export interface PendingPriceTrace {
  traceId: string;
  model?: ModelRef;
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
  /** Replaced as a whole block when provided (id + provider). */
  model?: ModelRef;
  domain?: string;
  subdomain?: string;
}

export interface PendingStamp {
  stampedCosts: StampedTokenCost[];
  totalCostMicrocents: number;
  stampedAt: Date;
}

/**
 * Post-close reconciliation outcome (audit B-1, decision 100) — counts of
 * the two idempotent passes, surfaced in the close job's report.
 */
export interface QuarantineReconciliation {
  /** Traces of the month NOT billed by the snapshot, newly flagged. */
  flaggedStragglers: number;
  /** Previously flagged traces the snapshot DID bill, now marked absorbed. */
  absorbed: number;
}

/**
 * audit B-4 residual: the skipped branch MAY carry the stored trace's
 * consolidated token total, so the ingest path can detect source/store
 * token divergence with no second read. Adapters that already hold the
 * stored document SHOULD return the object form; the bare 'skipped'
 * stays valid (divergence visibility is then simply unavailable).
 */
export type InsertIfAbsentResult =
  | 'inserted'
  | 'skipped'
  | { outcome: 'skipped'; storedTokensTotal: number };

export interface TraceRepository {
  /**
   * Idempotent write keyed by the natural traceId: re-syncing a window can
   * never double-count, and an existing stamp is NEVER overwritten. One
   * trace = one document (decision 47), so the write is atomic.
   */
  insertIfAbsent(trace: TraceModel): Promise<InsertIfAbsentResult>;

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
   *
   * audit B-5: the CAS also pins the MODEL the prices were resolved for
   * (`pinnedModel`, null when the pending trace had none). A concurrent
   * attribution correction changing the model between the sweep's read and
   * this write makes the filter miss → 'skipped' → the next sweep re-reads
   * fresh and resolves prices for the corrected model. Without the pin,
   * model A's prices could be stamped — immutably — onto a trace whose
   * stored model is B.
   */
  stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
    pinnedModel: ModelRef | null,
  ): Promise<'stamped' | 'skipped'>;

  /** Slim projection, oldest first — never the embedded payloads. */
  findPendingPrice(): Promise<PendingPriceTrace[]>;

  /**
   * audit B-1 (decision 100 — "the snapshot adjudicates"): called by the
   * close AFTER the snapshot + period flip land, with the exact trace ids
   * the snapshot billed. Two idempotent passes over [monthStart, monthEnd):
   *
   * 1. FLAG STRAGGLERS — traces of the month NOT in `snapshotTraceIds`
   *    and not already flagged get `billingQuarantine: {reason:
   *    'period_closed', quarantinedAt}`. This mechanically closes the
   *    ingest-vs-close race: whatever interleaving let a trace slip in
   *    unflagged, the reconciliation flags it.
   * 2. ABSORB THE ADJUDICATED — flagged traces that ARE in
   *    `snapshotTraceIds` get `billingQuarantine.absorbedInSnapshotVersion
   *    = snapshotVersion`: the historical mark stays, but it no longer
   *    means "outside the bill" (the reopen→re-close correction flow,
   *    decision 89). Readers consider only UNRESOLVED quarantine (reason
   *    present, absorbed version absent).
   *
   * Safe to re-run (crash-retry): both updates are pure state convergence.
   */
  reconcileQuarantineAfterClose(
    monthStart: Date,
    monthEnd: Date,
    snapshotTraceIds: string[],
    snapshotVersion: number,
  ): Promise<QuarantineReconciliation>;
}
