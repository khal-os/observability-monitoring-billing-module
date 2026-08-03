import { SyncCursor } from '../../../../application/interfaces/trace-batch-source.js';
import { SyncStateRepository } from '../../../../application/interfaces/sync-state-repository.js';
import { MongoDb } from '@khal/core/infrastructure/database/mongodb/mongo-db.js';

export const SYNC_STATE_COLLECTION = 'sync_state';

/** One document per watermark, keyed by _id — no index/migration needed. */
const TRACE_CURSOR_ID = 'trace-sync';

// eslint-disable-next-line no-control-regex -- the FULL ASCII range is the point
const isAscii = (value: string): boolean => /^[\x00-\x7f]*$/.test(value);

export class MongoDbSyncStateRepository implements SyncStateRepository {
  private nonAsciiWarned = false;
  async getTraceCursor(): Promise<SyncCursor | null> {
    const document = await MongoDb.getCollection(SYNC_STATE_COLLECTION).findOne(
      { _id: TRACE_CURSOR_ID } as never,
    );

    if (!document) {
      return null;
    }

    return {
      updatedAt: document['cursorUpdatedAt'] as Date,
      traceId: document['cursorTraceId'] as string,
    };
  }

  /**
   * The watermark NEVER moves backwards. A blind upsert would let a slow
   * second drainer (an orphaned container after a deploy, an overlapping
   * manual run) overwrite a newer cursor with an older one — every write
   * is conditioned on the stored cursor being at or behind the new one,
   * in the same (updatedAt, traceId) order the batch source drains in.
   * A rejected write is not an error: the batch it bookmarks was already
   * persisted, and insertIfAbsent deduplicates any re-read.
   *
   * COLLATION ASSUMPTION (audit C-7.6): the `cursorTraceId` tiebreak
   * compares strings under MongoDB's default binary (UTF-8 byte) order,
   * and the batch source drains in ITS store's order. The two orders
   * provably coincide for ASCII ids — which is what every observed
   * source emits (UUID-ish hex/base62). For a non-ASCII id they may
   * disagree; the failure mode is CONSERVATIVE either way (a mis-ordered
   * comparison can only reject an advance, never regress the watermark —
   * the batch was already persisted and re-reads deduplicate), so a
   * non-ASCII id is worth a loud warning (it can pin throughput on
   * re-reads) but never a throw.
   */
  async setTraceCursor(cursor: SyncCursor): Promise<void> {
    const collection = MongoDb.getCollection(SYNC_STATE_COLLECTION);

    if (!this.nonAsciiWarned && !isAscii(cursor.traceId)) {
      this.nonAsciiWarned = true;
      console.warn(
        `sync-state: non-ASCII cursorTraceId ${JSON.stringify(cursor.traceId)} — ` +
          'binary collation may disagree with the source ordering; the watermark ' +
          'stays safe (advances can only be rejected, never regressed) but sync ' +
          'throughput may degrade on re-reads.',
      );
    }

    const fields = {
      cursorUpdatedAt: cursor.updatedAt,
      cursorTraceId: cursor.traceId,
      advancedAt: new Date(),
    };

    const notAhead = {
      $or: [
        { cursorUpdatedAt: { $lt: cursor.updatedAt } },
        {
          cursorUpdatedAt: cursor.updatedAt,
          cursorTraceId: { $lte: cursor.traceId },
        },
      ],
    };

    const advanced = await collection.updateOne(
      { _id: TRACE_CURSOR_ID, ...notAhead } as never,
      { $set: fields },
    );

    if (advanced.matchedCount > 0) {
      return;
    }

    // No match: either the stored cursor is ahead (stay put) or the
    // document doesn't exist yet. $setOnInsert only creates — it cannot
    // regress an existing document that appeared between the two calls.
    const created = await collection.updateOne(
      { _id: TRACE_CURSOR_ID } as never,
      { $setOnInsert: fields },
      { upsert: true },
    );

    if (created.upsertedCount > 0) {
      return;
    }

    // The document was created by a racer between our two calls; it may
    // hold an older cursor than ours. One conditional retry settles it —
    // if this one also misses, the stored cursor is genuinely ahead.
    await collection.updateOne({ _id: TRACE_CURSOR_ID, ...notAhead } as never, {
      $set: fields,
    });
  }
}
