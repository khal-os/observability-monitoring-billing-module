import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { MongoDbBillingQueryRepository } from '../billing/mongodb-billing-query-repository.js';
import { migrations } from './index.js';
import { runMigrations } from '../helpers/migration-runner.js';
import { makeContractTrace } from '../../../../application/interfaces/trace-repository.contract.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';

/**
 * audit F-3 pinned by EXPLAIN: with the full migration chain applied, the
 * watermark aggregation must be index-covered — zero documents fetched.
 * On revert (drop migration 022) this reads docsExamined === seeded count.
 */
describe('migration 022-ingestion-watermark-index (audit F-3)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST serve ingestionWatermark without fetching a single trace document', async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await MongoDb.getCollection('migrations').deleteMany({});
    await runMigrations(MongoDb.getClient().db(), migrations);

    const traces = new MongoDbTraceRepository();
    for (let i = 0; i < 50; i += 1) {
      await traces.insertIfAbsent(
        makeContractTrace({
          traceId: `wm-${String(i).padStart(2, '0')}`,
          startedAt: new Date(Date.UTC(2026, 5, 1 + (i % 28), 12)),
          ingestedAt: new Date(Date.UTC(2026, 5, 1 + (i % 28), 13)),
        }),
      );
    }

    const explain = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate(
        [
          {
            $match: {
              startedAt: {
                $gte: new Date('2026-06-01T00:00:00Z'),
                $lt: new Date('2026-07-01T00:00:00Z'),
              },
            },
          },
          { $group: { _id: null, watermark: { $max: '$ingestedAt' } } },
        ],
        {},
      )
      .explain('executionStats');

    const stats = explain as {
      stages?: {
        $cursor?: { executionStats?: { totalDocsExamined?: number } };
      }[];
      executionStats?: { totalDocsExamined?: number };
    };
    const docsExamined =
      stats.executionStats?.totalDocsExamined ??
      stats.stages?.[0]?.$cursor?.executionStats?.totalDocsExamined;

    expect(docsExamined).toBe(0);

    // And the adapter still answers correctly through the covered plan.
    const repository = new MongoDbBillingQueryRepository();
    const watermark = await repository.ingestionWatermark(
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );

    expect(watermark?.toISOString()).toBe('2026-06-28T13:00:00.000Z');
  });
});
