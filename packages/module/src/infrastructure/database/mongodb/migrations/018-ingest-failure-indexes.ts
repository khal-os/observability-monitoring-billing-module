import { Migration } from '../helpers/migration-runner.js';
import { INGEST_FAILURES_COLLECTION } from '../ingestFailures/mongodb-ingest-failure-repository.js';
import { POISON_ROWS_COLLECTION } from '../ingestFailures/mongodb-poison-row-repository.js';

/**
 * audit B-3/C-6.2 — the durable recovery trail of the sync:
 * - ingest_failures: dead-letter upserts keyed by (traceId, kind) — one
 *   document per failing trace (and per truncation event), attempts
 *   counted on re-encounter;
 * - poison_rows: source rows that failed boundary validation, keyed by
 *   (kind, id) — the durable form of the decision-62 skip-and-log.
 * Unique indexes make the upserts race-safe (two concurrent syncs cannot
 * mint duplicate dead letters for one trace).
 */
export const ingestFailureIndexes: Migration = {
  id: '018-ingest-failure-indexes',

  async run(db) {
    await db
      .collection(INGEST_FAILURES_COLLECTION)
      .createIndex({ traceId: 1, kind: 1 }, { unique: true });

    await db
      .collection(POISON_ROWS_COLLECTION)
      .createIndex({ kind: 1, id: 1 }, { unique: true });
  },
};
