import { isDuplicateKeyError } from './is-duplicate-key-error.js';

/**
 * THE house first-touch retry, next to isDuplicateKeyError (wave review):
 * an upsert/$merge under a unique index whose FIRST touch two writers can
 * race into. The ingestion worker and a manual `make sync` are a
 * documented-legal combination, so this is reachable in normal operation
 * for all three writes that use it — the sync's bookkeeping trails
 * (ingest_failures, poison_rows, re-audit 2026-08 sync minors) and the
 * session-summary $merge (audit B-6).
 *
 * The race answers E11000; one retry settles it, because the second pass
 * finds the document and updates instead of inserting. Without it the raw
 * error escapes the repository and aborts a whole batch over a trail row
 * — exactly backwards, since the trail exists to keep the batch moving.
 */
export const retryOnceOnDuplicateKey = async (
  write: () => Promise<unknown>,
): Promise<void> => {
  try {
    await write();
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }

    await write();
  }
};
