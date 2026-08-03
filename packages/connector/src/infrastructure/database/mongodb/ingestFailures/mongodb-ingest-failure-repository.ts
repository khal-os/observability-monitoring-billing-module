import {
  IngestFailureKind,
  IngestFailureRecord,
  IngestFailureRepository,
  IngestTruncationRecord,
} from '../../../../application/interfaces/ingest-failure-repository.js';
import { MongoDb } from '@khal/core/infrastructure/database/mongodb/mongo-db.js';
import { retryOnceOnDuplicateKey } from '@khal/core/infrastructure/database/mongodb/helpers/retry-once-on-duplicate-key.js';

import { INGEST_FAILURES_COLLECTION } from '@khal/core/infrastructure/database/mongodb/collections.js';

/**
 * Does this kind mean "the trace is NOT in the archive"? (countUnresolved).
 *
 * Wave review: a Record over the port's union, not a loose string list —
 * adding a kind to IngestFailureKind then FAILS TO COMPILE here until
 * someone decides whether it counts as a parked trace. The wrong default
 * is silent either way: a missed kind hides traces the archive lacks, a
 * wrongly-included one cries wolf at an operator every cycle.
 */
const KIND_IS_UNRESOLVED: Record<IngestFailureKind, boolean> = {
  ingest_failure: true,
  oversized_unstorable: true,
};

const FAILURE_KINDS = Object.entries(KIND_IS_UNRESOLVED)
  .filter(([, unresolved]) => unresolved)
  .map(([kind]) => kind);

/** The truncation EVENT kind — a stored-but-clipped trace, not a failure. */
const TRUNCATION_KIND = 'content_truncation';

/**
 * audit B-3 — dead-letter store of the sync. One document per
 * (traceId, kind), upserted: `attempts` counts re-encounters (an
 * idempotent re-sync hitting the same poison trace bumps it), the error
 * and context always reflect the LATEST encounter, `firstSeenAt` stays
 * pinned at discovery. Truncation events share the collection under their
 * own kind — they are audit marks of a stored-but-clipped trace, not
 * failures.
 *
 * re-audit 2026-08 (sync minors): every upsert here goes through
 * retryOnceOnDuplicateKey — two writers CAN meet on a first touch, and a
 * raw E11000 escaping a bookkeeping write would abort the very batch this
 * trail exists to keep moving.
 */
export class MongoDbIngestFailureRepository implements IngestFailureRepository {
  async recordFailure(record: IngestFailureRecord): Promise<void> {
    await retryOnceOnDuplicateKey(() =>
      MongoDb.getCollection(INGEST_FAILURES_COLLECTION).updateOne(
        { traceId: record.traceId, kind: record.kind },
        {
          $setOnInsert: { firstSeenAt: record.seenAt },
          $set: {
            context: record.context,
            error: record.error,
            lastSeenAt: record.seenAt,
          },
          $inc: { attempts: 1 },
        },
        { upsert: true },
      ),
    );
  }

  async recordTruncation(record: IngestTruncationRecord): Promise<void> {
    await retryOnceOnDuplicateKey(() =>
      MongoDb.getCollection(INGEST_FAILURES_COLLECTION).updateOne(
        { traceId: record.traceId, kind: TRUNCATION_KIND },
        {
          $setOnInsert: { firstSeenAt: record.seenAt },
          $set: {
            originalBytes: record.originalBytes,
            lastSeenAt: record.seenAt,
          },
          $inc: { attempts: 1 },
        },
        { upsert: true },
      ),
    );
  }

  async countUnresolved(): Promise<number> {
    // Truncation events are excluded — those traces ARE stored (see the
    // port's contract). No index on `kind` alone: the (traceId, kind)
    // unique index does not serve this shape, and it does not need to —
    // this collection is a dead-letter trail an operator drains, sized in
    // rows, not in traces. If it ever grows past that, the count is the
    // symptom, not the cost.
    return MongoDb.getCollection(INGEST_FAILURES_COLLECTION).countDocuments({
      kind: { $in: FAILURE_KINDS },
    });
  }
}
