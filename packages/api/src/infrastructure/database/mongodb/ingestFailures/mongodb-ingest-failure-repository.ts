import {
  IngestFailureRecord,
  IngestFailureRepository,
  IngestTruncationRecord,
} from '../../../../application/interfaces/ingest-failure-repository.js';
import { MongoDb } from '../mongo-db.js';

export const INGEST_FAILURES_COLLECTION = 'ingest_failures';

/**
 * audit B-3 — dead-letter store of the sync. One document per
 * (traceId, kind), upserted: `attempts` counts re-encounters (an
 * idempotent re-sync hitting the same poison trace bumps it), the error
 * and context always reflect the LATEST encounter, `firstSeenAt` stays
 * pinned at discovery. Truncation events share the collection under their
 * own kind — they are audit marks of a stored-but-clipped trace, not
 * failures.
 */
export class MongoDbIngestFailureRepository implements IngestFailureRepository {
  async recordFailure(record: IngestFailureRecord): Promise<void> {
    await MongoDb.getCollection(INGEST_FAILURES_COLLECTION).updateOne(
      { traceId: record.traceId, kind: 'ingest_failure' },
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
    );
  }

  async recordTruncation(record: IngestTruncationRecord): Promise<void> {
    await MongoDb.getCollection(INGEST_FAILURES_COLLECTION).updateOne(
      { traceId: record.traceId, kind: 'content_truncation' },
      {
        $setOnInsert: { firstSeenAt: record.seenAt },
        $set: {
          originalBytes: record.originalBytes,
          lastSeenAt: record.seenAt,
        },
        $inc: { attempts: 1 },
      },
      { upsert: true },
    );
  }
}
