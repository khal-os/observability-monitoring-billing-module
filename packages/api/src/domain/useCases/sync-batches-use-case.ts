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
