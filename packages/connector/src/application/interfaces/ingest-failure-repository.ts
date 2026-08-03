/**
 * audit B-3 — the durable dead-letter trail of ingestion. Before this
 * port existed, one deterministic per-trace failure (oversized document,
 * corrupt token counts) stalled the whole sync forever: the loop retried
 * the same batch while the source's ~49-day retention burned behind the
 * cursor — the exact archive loss invariant 6 exists to prevent. Now a
 * failing trace is recorded HERE and the batch continues; this collection
 * is the recovery trail, not the container log.
 */
/**
 * re-audit 2026-08 (sync item 4): dead letters are not all the same
 * failure. A generic `ingest_failure` is re-runnable — the operator
 * re-syncs the recorded context window and the trace lands. An
 * `oversized_unstorable` trace never will: no clip pass brings it under
 * the document cap, so a re-sync is wasted work and the row is the
 * decision record, not a retry hint (README Day-2 tells them apart).
 */
export type IngestFailureKind = 'ingest_failure' | 'oversized_unstorable';

export interface IngestFailureRecord {
  traceId: string;
  kind: IngestFailureKind;
  /**
   * Where the sync stood when the trace failed — the windowed run records
   * its window, the continuous loop its cursor.
   */
  context: string;
  error: string;
  seenAt: Date;
}

export interface IngestTruncationRecord {
  traceId: string;
  /** Estimated serialized size of the FULL document, before truncation. */
  originalBytes: number;
  seenAt: Date;
}

export interface IngestFailureRepository {
  /**
   * Upsert keyed by traceId: re-encounters increment an attempts counter
   * and refresh the error/context; firstSeenAt stays pinned at discovery.
   */
  recordFailure(record: IngestFailureRecord): Promise<void>;

  /**
   * Truncation EVENT, not a failure (audit B-3/Q8): the trace WAS stored —
   * tokens, costs and the price stamp intact, content clipped to markers.
   * Recorded so the clipping is auditable, never silent.
   */
  recordTruncation(record: IngestTruncationRecord): Promise<void>;

  /**
   * re-audit 2026-08 (sync item 3): how many traces are currently PARKED
   * in the trail — every failure-kind row, since the runbook resolves a
   * dead letter by re-syncing its context window and DELETING the row
   * (there is no resolved flag; a row that exists is a trace the archive
   * is still missing). Truncation events are excluded: those traces ARE
   * stored, the row is an audit mark. Cheap by contract (a counting
   * query) — the ingestion worker asks once per cycle.
   */
  countUnresolved(): Promise<number>;
}

/**
 * Write-boundary document size estimate, in bytes (audit B-3 size guard).
 * Implemented by the storage adapter — it knows the exact serialization
 * (BSON) the store would produce — and injected by the composition root;
 * the ingest path stays storage-blind.
 */
export type EstimateDocumentBytes = (document: object) => number;
