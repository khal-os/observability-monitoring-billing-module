export interface BatchSyncReport {
  /** Raw source rows scanned this batch (poison rows included). */
  scanned: number;
  inserted: number;
  /** Already-ingested traces skipped by idempotency (attribution refreshed). */
  skipped: number;
  /** Traces ingested WITHOUT an applicable price — kept, cost open, never R$ 0. */
  pendingPrice: number;
  /** Traces dated inside a CLOSED month (T6): stored flagged, never billed. */
  quarantined: number;
  /**
   * Traces that failed ingestion and were dead-lettered (audit B-3) — the
   * batch continues and the cursor still advances; ingest_failures is the
   * recovery trail.
   */
  failed: number;
  /**
   * Skipped re-syncs whose SOURCE token totals no longer match the stored
   * trace (audit B-4 residual, Q3: logged + counted only — the stamp is
   * immutable and stored counts are never mutated).
   */
  tokenDivergence: number;
  /** True when the source had fewer rows than the batch limit — the loop sleeps. */
  caughtUp: boolean;
}

/**
 * Continuous-sync counterpart of SyncTracesUseCase: one bounded step of
 * the watermark loop. Each call processes at most one batch and advances
 * the persisted cursor only after the batch is fully in the store.
 */
export interface SyncBatchesUseCase {
  syncNextBatch(): Promise<BatchSyncReport>;
}
