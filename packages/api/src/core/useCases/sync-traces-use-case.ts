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
}

export interface SyncTracesUseCase {
  sync(window: SyncWindowInput): Promise<SyncReport>;
}
