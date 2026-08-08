import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { MongoDbBillingQueryRepository } from '../billing/mongodb-billing-query-repository.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { traceIndexes } from './003-trace-indexes.js';
import { quarantineIndex } from './021-quarantine-index.js';

const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
const JULY_START = new Date('2026-07-01T00:00:00.000Z');

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'q-trace',
  agent: { id: 'eugenia' },
  model: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
  type: 'chat',
  channel: { type: 'whatsapp' },
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 1_000 },
  tokensTotal: 1_000,
  pricingStatus: 'stamped',
  stampedCosts: [],
  totalCostMicrocents: 0,
  stampedAt: new Date('2026-06-05T14:01:00.000Z'),
  ingestedAt: new Date('2026-06-05T14:01:00.000Z'),
  input: 'in',
  output: 'out',
  spans: [],
  ...overrides,
});

const indexByName = async (name: string) =>
  (await MongoDb.getCollection(TRACES_COLLECTION).indexes()).find(
    (index) => index.name === name,
  );

describe('migration 021-quarantine-index (re-audit)', () => {
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
    await MongoDb.getClient().db().createCollection(TRACES_COLLECTION);
  });

  it('MUST create the partial index countQuarantined rides, and be idempotent', async () => {
    const db = MongoDb.getClient().db();

    await quarantineIndex.run(db);
    await quarantineIndex.run(db);

    const index = await indexByName('quarantine_startedAt');

    expect(index?.key).toEqual({ startedAt: 1 });
    // The partial filter is the query's own predicate, verbatim — that is
    // what makes the planner qualify the index, and it is what keeps the
    // index to the handful of quarantined traces.
    expect(index?.partialFilterExpression).toEqual({
      'billingQuarantine.reason': { $exists: true },
    });
    expect(
      (await MongoDb.getCollection(TRACES_COLLECTION).indexes()).filter(
        (candidate) => candidate.name === 'quarantine_startedAt',
      ),
    ).toHaveLength(1);
  });

  it('MUST be the index the REAL countQuarantined query plan chooses', async () => {
    const db = MongoDb.getClient().db();
    // The production index set: without 021 the query rides 003's
    // {startedAt: -1} and FETCHes every trace of the month.
    await traceIndexes.run(db);
    await quarantineIndex.run(db);

    const traces = new MongoDbTraceRepository();

    for (let index = 0; index < 200; index += 1) {
      await traces.insertIfAbsent(
        makeTrace({
          traceId: `bulk-${index}`,
          startedAt: new Date(Date.UTC(2026, 5, 1 + (index % 28), 12)),
        }),
      );
    }

    await traces.insertIfAbsent(
      makeTrace({
        traceId: 'unresolved-1',
        billingQuarantine: {
          reason: 'period_closed',
          quarantinedAt: new Date(),
        },
      }),
    );
    await traces.insertIfAbsent(
      makeTrace({
        traceId: 'absorbed-1',
        billingQuarantine: {
          reason: 'period_closed',
          quarantinedAt: new Date(),
          absorbedInSnapshotVersion: 2,
        },
      }),
    );

    const before = await accessOps();

    expect(
      await new MongoDbBillingQueryRepository().countQuarantined(
        JUNE_START,
        JULY_START,
      ),
    ).toBe(1);

    // $indexStats attributes the read to the index the planner actually
    // used — no predicate is duplicated here, so the assertion follows the
    // real query wherever it goes. Reverting the migration leaves the
    // partial index absent and this counter flat.
    expect((await accessOps()) - before).toBeGreaterThan(0);
  });
});

/** Reads of the partial index since it was created (0 when it does not exist). */
const accessOps = async (): Promise<number> => {
  const stats = (await MongoDb.getCollection(TRACES_COLLECTION)
    .aggregate([{ $indexStats: {} }])
    .toArray()) as { name: string; accesses: { ops: number } }[];

  return Number(
    stats.find((entry) => entry.name === 'quarantine_startedAt')?.accesses
      .ops ?? 0,
  );
};
