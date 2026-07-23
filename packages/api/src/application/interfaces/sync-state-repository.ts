import { SyncCursor } from './trace-batch-source.js';

/**
 * The watermark: ONE tiny record marking "everything up to here is safely
 * in the store". The loop's crash story depends on the write protocol —
 * the cursor is advanced ONLY after its whole batch is persisted, so any
 * crash at worst re-reads a batch that insertIfAbsent then deduplicates.
 * Never advanced speculatively.
 */
export interface SyncStateRepository {
  /** `null` on a fresh deployment — the loop starts from the beginning. */
  getTraceCursor(): Promise<SyncCursor | null>;

  setTraceCursor(cursor: SyncCursor): Promise<void>;
}
