import {
  PoisonRowRecord,
  PoisonRowRepository,
} from '../../../../application/interfaces/poison-row-repository.js';
import { MongoDb } from '@khal/core/infrastructure/database/mongodb/mongo-db.js';
import { retryOnceOnDuplicateKey } from '@khal/core/infrastructure/database/mongodb/helpers/retry-once-on-duplicate-key.js';

import { POISON_ROWS_COLLECTION } from '@khal/core/infrastructure/database/mongodb/collections.js';

/**
 * audit C-6.2: the raw row is forensics, not contract — archived only when
 * small enough to be harmless to the working set. Above this, the error +
 * id still let an operator re-fetch the row from the source (while its
 * retention lasts).
 */
const MAX_RAW_ROW_BYTES = 64 * 1024;

/**
 * audit C-6.2 — durable poison trail. One document per (kind, id),
 * upserted: `seenCount` counts re-encounters, error/context reflect the
 * latest one, `firstSeenAt` stays pinned at discovery.
 *
 * re-audit 2026-08 (sync minors): the upsert retries once on E11000 (see
 * retryOnceOnDuplicateKey) — a first-touch race between two readers of
 * the same poison row must not escape as an error and kill the fetch.
 */
export class MongoDbPoisonRowRepository implements PoisonRowRepository {
  async record(row: PoisonRowRecord): Promise<void> {
    await retryOnceOnDuplicateKey(() =>
      MongoDb.getCollection(POISON_ROWS_COLLECTION).updateOne(
        { kind: row.kind, id: row.id },
        {
          $setOnInsert: { firstSeenAt: row.seenAt },
          $set: {
            context: row.context,
            error: row.error,
            lastSeenAt: row.seenAt,
            ...(hasSmallRawRow(row) ? { rawRow: row.rawRow } : {}),
          },
          $inc: { seenCount: 1 },
        },
        { upsert: true },
      ),
    );
  }
}

const hasSmallRawRow = (row: PoisonRowRecord): boolean => {
  if (row.rawRow === undefined) {
    return false;
  }

  try {
    const serialized = JSON.stringify(row.rawRow);

    return (
      serialized !== undefined &&
      Buffer.byteLength(serialized, 'utf8') < MAX_RAW_ROW_BYTES
    );
  } catch {
    // Circular/unserializable rows: keep the error, drop the payload.
    return false;
  }
};
