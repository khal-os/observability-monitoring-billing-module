import { MongoDb } from '@observability/core/infrastructure/database/mongodb/mongo-db.js';
import { POISON_ROWS_COLLECTION } from '@observability/core/infrastructure/database/mongodb/collections.js';
import { ingestFailureIndexes } from '@observability/core/infrastructure/database/mongodb/migrations/018-ingest-failure-indexes.js';
import { MongoDbPoisonRowRepository } from './mongodb-poison-row-repository.js';

/**
 * audit E-4: neither ingestion-failure repository was exercised by any
 * test in any package — the durable poison trail is what invariant 6
 * leans on when a source row is skipped past the cursor and the source's
 * ~49-day retention expires, and its one-document-per-(kind,id) property
 * exists only because migration 018's unique index fires. Run against
 * the production index, like mongodb-trace-repository.test.ts does for
 * the unique traceId.
 */
describe('MongoDbPoisonRowRepository against the production index (audit E-4)', () => {
  const repository = new MongoDbPoisonRowRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
    await ingestFailureIndexes.run(MongoDb.getClient().db());
  });

  beforeEach(async () => {
    await MongoDb.getCollection(POISON_ROWS_COLLECTION).deleteMany({});
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST keep ONE document per (kind, id) — seenCount accumulates, firstSeenAt pins, lastSeenAt advances', async () => {
    await repository.record({
      kind: 'summary',
      id: 'trace-poison',
      context: 'window=[a,b)',
      error: 'zod: occurredAtMs expected number',
      seenAt: new Date('2026-07-01T10:00:00Z'),
    });
    await repository.record({
      kind: 'summary',
      id: 'trace-poison',
      context: 'window=[a,b) re-run',
      error: 'zod: occurredAtMs expected number',
      seenAt: new Date('2026-07-02T10:00:00Z'),
    });

    const rows = await MongoDb.getCollection(POISON_ROWS_COLLECTION)
      .find({})
      .toArray();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'summary',
      id: 'trace-poison',
      seenCount: 2,
      context: 'window=[a,b) re-run',
    });
    expect((rows[0]?.['firstSeenAt'] as Date).toISOString()).toBe(
      '2026-07-01T10:00:00.000Z',
    );
    expect((rows[0]?.['lastSeenAt'] as Date).toISOString()).toBe(
      '2026-07-02T10:00:00.000Z',
    );
  });

  it('MUST drop an oversized rawRow while keeping the error — the trail never becomes its own 16MB problem', async () => {
    await repository.record({
      kind: 'summary',
      id: 'trace-big',
      context: 'window=[a,b)',
      error: 'corrupt token counts',
      seenAt: new Date('2026-07-01T10:00:00Z'),
      rawRow: { blob: 'x'.repeat(6_000_000) },
    });

    const row = await MongoDb.getCollection(POISON_ROWS_COLLECTION).findOne({
      id: 'trace-big',
    });

    expect(row?.['rawRow']).toBeUndefined();
    expect(row?.['error']).toBe('corrupt token counts');
  });
});
