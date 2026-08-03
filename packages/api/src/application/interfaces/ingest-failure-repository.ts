/**
 * audit B-3 — the durable dead-letter trail of ingestion. Before this
 * port existed, one deterministic per-trace failure (oversized document,
 * corrupt token counts) stalled the whole sync forever: the loop retried
 * the same batch while the source's ~49-day retention burned behind the
 * cursor — the exact archive loss invariant 6 exists to prevent. Now a
 * failing trace is recorded HERE and the batch continues; this collection
 * is the recovery trail, not the container log.
 */
export interface IngestFailureRecord {
  traceId: string;
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
}

/**
 * Write-boundary document size estimate, in bytes (audit B-3 size guard).
 * Implemented by the storage adapter — it knows the exact serialization
 * (BSON) the store would produce — and injected by the composition root;
 * the ingest path stays storage-blind.
 */
export type EstimateDocumentBytes = (document: object) => number;
