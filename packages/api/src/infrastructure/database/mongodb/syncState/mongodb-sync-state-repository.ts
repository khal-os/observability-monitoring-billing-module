import { SyncCursor } from '../../../../application/interfaces/trace-batch-source.js';
import { SyncStateRepository } from '../../../../application/interfaces/sync-state-repository.js';
import { MongoDb } from '../mongo-db.js';

export const SYNC_STATE_COLLECTION = 'sync_state';

/** One document per watermark, keyed by _id — no index/migration needed. */
const TRACE_CURSOR_ID = 'trace-sync';

export class MongoDbSyncStateRepository implements SyncStateRepository {
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

  async setTraceCursor(cursor: SyncCursor): Promise<void> {
    await MongoDb.getCollection(SYNC_STATE_COLLECTION).updateOne(
      { _id: TRACE_CURSOR_ID } as never,
      {
        $set: {
          cursorUpdatedAt: cursor.updatedAt,
          cursorTraceId: cursor.traceId,
          advancedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
}
