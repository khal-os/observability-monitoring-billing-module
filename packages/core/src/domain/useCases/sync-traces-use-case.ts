export interface SyncWindowInput {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end. */
  to: Date;
}

export interface SyncReport {
  window: SyncWindowInput;
  fetched: number;
  inserted: number;
  /** Already-ingested traces skipped by idempotency (attribution refreshed). */
  skipped: number;
  /** Traces ingested WITHOUT an applicable price — kept, cost open, never R$ 0. */
  pendingPrice: number;
  /** Traces dated inside a CLOSED month (T6): stored flagged, never billed. */
  quarantined: number;
  /**
   * Traces that failed ingestion and were dead-lettered (audit B-3) — the
   * run continues past them; ingest_failures is the recovery trail.
   */
  failed: number;
  /**
   * Skipped re-syncs whose SOURCE token totals no longer match the stored
   * trace (audit B-4 residual, Q3: logged + counted only — the stamp is
   * immutable and stored counts are never mutated).
   */
  tokenDivergence: number;
}

export interface SyncTracesUseCase {
  sync(window: SyncWindowInput): Promise<SyncReport>;
}
