import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { traceIndexes } from './003-trace-indexes.js';
import { sessionChainIndex } from './020-session-chain-index.js';

const indexKeys = async () => {
  const indexes = await MongoDb.getCollection(TRACES_COLLECTION).indexes();

  return indexes.map((index) => JSON.stringify(index.key));
};

describe('migration 020-session-chain-index (audit C-7.6)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION)
      .drop()
      .catch(() => undefined);
    // The collection must exist for dropIndexIfExists (020 always runs
    // after 003 in the chain — replicated here).
    await MongoDb.getClient().db().createCollection(TRACES_COLLECTION);
  });

  it('MUST supersede 003\'s {sessionId, startedAt} with the full chain-sort key', async () => {
    const db = MongoDb.getClient().db();
    await traceIndexes.run(db);

    await sessionChainIndex.run(db);

    const keys = await indexKeys();
    expect(keys).toContain(
      JSON.stringify({ sessionId: 1, startedAt: 1, traceId: 1 }),
    );
    expect(keys).not.toContain(JSON.stringify({ sessionId: 1, startedAt: 1 }));
  });

  it('MUST be idempotent and tolerate the narrower index never existing (fresh chain)', async () => {
    const db = MongoDb.getClient().db();

    await sessionChainIndex.run(db);
    await sessionChainIndex.run(db);

    const keys = await indexKeys();
    expect(
      keys.filter(
        (key) =>
          key === JSON.stringify({ sessionId: 1, startedAt: 1, traceId: 1 }),
      ),
    ).toHaveLength(1);
  });
});
