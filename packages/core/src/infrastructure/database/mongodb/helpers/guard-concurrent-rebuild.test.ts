import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { guardConcurrentRebuild } from './guard-concurrent-rebuild.js';

/**
 * audit F-1: the rebuild jobs' $out swap discards concurrent maintenance
 * writes, and nothing told the operator to stop the worker. The guard
 * makes the job refuse to finish when ingestion advanced during it.
 */
describe('guardConcurrentRebuild (audit F-1)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST complete when no ingestion happens during the rebuild', async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).insertOne({ traceId: 't-1' });

    await expect(
      guardConcurrentRebuild(async () => {
        /* a rebuild that touches nothing new */
      }),
    ).resolves.toBeUndefined();
  });

  it('MUST throw when a trace is ingested DURING the rebuild — the swap discarded its maintenance write', async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).insertOne({ traceId: 't-1' });

    await expect(
      guardConcurrentRebuild(async () => {
        // The always-on worker ingests mid-rebuild.
        await MongoDb.getCollection(TRACES_COLLECTION).insertOne({
          traceId: 't-2',
        });
      }),
    ).rejects.toThrow(/Ingestion advanced DURING the rebuild/);
  });
});
