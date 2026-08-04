import { MongoDb } from '../mongo-db.js';
import {
  INGEST_FAILURES_COLLECTION,
  POISON_ROWS_COLLECTION,
} from '../collections.js';
import { ingestFailureIndexes } from './018-ingest-failure-indexes.js';

/**
 * audit E-4: migrations 015/019/020/021 each had a test; 018 had NONE —
 * and its indexes are correctness, not speed: the migration's own comment
 * says "unique indexes make the upserts race-safe (two concurrent syncs
 * cannot mint duplicate dead letters for one trace)", and the
 * retry-once-on-E11000 in both repositories is only reachable when these
 * unique indexes actually fire. Drop `unique: true` and the whole suite
 * used to stay green while the durable dead-letter trail (invariant 6's
 * recovery record) silently stopped being one-document-per-failure.
 */
describe('migration 018-ingest-failure-indexes (audit E-4)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    for (const name of [INGEST_FAILURES_COLLECTION, POISON_ROWS_COLLECTION]) {
      await MongoDb.getCollection(name)
        .drop()
        .catch(() => undefined);
    }
  });

  const uniqueIndexOn = async (collection: string) =>
    (await MongoDb.getCollection(collection).indexes()).filter(
      (index) => index.unique === true,
    );

  it('MUST create the UNIQUE dead-letter and poison-row indexes', async () => {
    await ingestFailureIndexes.run(MongoDb.getClient().db());

    const ingestUnique = await uniqueIndexOn(INGEST_FAILURES_COLLECTION);
    const poisonUnique = await uniqueIndexOn(POISON_ROWS_COLLECTION);

    expect(ingestUnique.map((index) => index.key)).toEqual([{ traceId: 1, kind: 1 }]);
    expect(poisonUnique.map((index) => index.key)).toEqual([
      { kind: 1, id: 1 },
    ]);
  });

  it('MUST be idempotent — a second run changes nothing', async () => {
    await ingestFailureIndexes.run(MongoDb.getClient().db());
    const before = await MongoDb.getCollection(POISON_ROWS_COLLECTION).indexes();

    await ingestFailureIndexes.run(MongoDb.getClient().db());
    const after = await MongoDb.getCollection(POISON_ROWS_COLLECTION).indexes();

    expect(after).toEqual(before);
  });
});
