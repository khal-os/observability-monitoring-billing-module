import { SourceTrace } from './trace-source-client.js';

/**
 * Cursor over the SOURCE's ingestion order — (updatedAt, traceId) of the
 * last row scanned, tie-broken by traceId because many rows can share one
 * millisecond. The axis is deliberately the source's write time, NOT the
 * trace's own startedAt: a trace delivered late (agent retry, batched
 * flush) lands AHEAD of the cursor no matter how old the trace itself is,
 * so late arrivals are structurally impossible to miss.
 */
export interface SyncCursor {
  updatedAt: Date;
  traceId: string;
}

export interface TraceBatch {
  traces: SourceTrace[];
  /**
   * Cursor of the last RAW row scanned — including rows skipped as poison
   * (decision 62: skip-and-log), so a malformed row can never stall the
   * sync. `null` when the batch was empty (nothing to advance to).
   */
  nextCursor: SyncCursor | null;
  /** Raw rows scanned (poison included). `scanned < limit` ⇒ caught up. */
  scanned: number;
}

/**
 * VENDOR-NEUTRAL port for cursor-paged ingestion — the continuous-sync
 * counterpart of TraceSourceClient's one-off windows. Memory is bounded by
 * construction: a call never returns more than `limit` traces, whatever
 * the backlog size (the loop's whole memory story rests on this).
 */
export interface TraceBatchSource {
  fetchBatch(args: {
    /** Resume point; `null` = from the beginning of the source's history. */
    after: SyncCursor | null;
    limit: number;
    /**
     * Quiet-period ceiling: only rows last updated BEFORE this instant are
     * returned. The source builds traces incrementally, and the price
     * stamp is immutable — syncing a still-changing trace would freeze
     * partial token counts (decision 61: 15 min of silence first).
     */
    updatedBefore: Date;
  }): Promise<TraceBatch>;

  /**
   * The SOURCE's clock, when the source can serve it cheaply (audit
   * C-6.4): the quiet period is measured against the source's write
   * times, so a worker clock N minutes behind the source would silently
   * shrink the 15-minute quiet period to 15−N and re-open the
   * partial-stamp hole decision 61 closed. Optional — sources without a
   * queryable clock fall back to the worker's clock.
   */
  sourceNow?(): Promise<Date>;

  /**
   * FATAL startup tripwire (audit C-7 — a source-contract concern, so it
   * lives on the PORT, not on one adapter): a source whose internal schema
   * drifted (e.g. a vendor image upgrade) must abort the worker BEFORE it
   * stamps traces from an unverified shape, immutably. Because it is on the
   * port, the composition root returns the PORT and the worker no longer
   * binds to a concrete adapter class.
   */
  assertCompatibleSchema(): Promise<void>;
}
