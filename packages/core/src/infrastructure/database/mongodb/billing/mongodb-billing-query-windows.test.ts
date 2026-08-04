import { MongoDb } from '../mongo-db.js';
import { runMigrations } from '../helpers/migration-runner.js';
import { migrations } from '../migrations/index.js';
import { MongoDbBillingQueryRepository } from './mongodb-billing-query-repository.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';
import { TRACES_COLLECTION } from '../collections.js';
import { makeContractTrace } from '../../../../application/interfaces/trace-repository.contract.js';

/**
 * The WINDOW arguments of the billing-query port, proven against the REAL
 * adapter (audit E-2): the unit fakes truncated these parameters for
 * months — `accruedCostMicrocents()` took ZERO arguments against a port
 * that takes two — so a regression in the adapter's `$lt` bound was
 * structurally unfalsifiable: drop `startOfToday` from the projection's
 * numerator and every spec stayed green while every current-month
 * run-rate silently inflated. These cases fail on exactly those reverts.
 */
const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
const JULY_START = new Date('2026-07-01T00:00:00.000Z');

describe('Billing query windows against the real adapter (audit E-2)', () => {
  const repository = new MongoDbBillingQueryRepository();
  const traces = new MongoDbTraceRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await runMigrations(MongoDb.getClient().db(), migrations);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  const seed = async (
    traceId: string,
    startedAt: Date,
    ingestedAt: Date,
    costMicrocents: number,
  ) => {
    await traces.insertIfAbsent(
      makeContractTrace({
        traceId,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 1000),
        ingestedAt,
        totalCostMicrocents: costMicrocents,
      }),
    );
  };

  it("accruedCostMicrocents MUST honor BOTH window bounds — the projection depends on excluding today's partial day", async () => {
    await seed('w-1', new Date('2026-06-05T10:00:00Z'), new Date('2026-06-05T11:00:00Z'), 100_000);
    await seed('w-2', new Date('2026-06-20T10:00:00Z'), new Date('2026-06-20T11:00:00Z'), 200_000);
    await seed('w-3', new Date('2026-07-02T10:00:00Z'), new Date('2026-07-02T11:00:00Z'), 400_000);

    const upToMidJune = new Date('2026-06-15T00:00:00.000Z');

    expect(
      await repository.accruedCostMicrocents(JUNE_START, upToMidJune),
    ).toBe(100_000);
    expect(
      await repository.accruedCostMicrocents(JUNE_START, JULY_START),
    ).toBe(300_000);
  });

  it("ingestionWatermark MUST stay inside the month window — a closed month's frozen audit must never carry a LATER month's freshness", async () => {
    await seed('m-1', new Date('2026-06-10T10:00:00Z'), new Date('2026-06-10T12:00:00Z'), 100_000);
    // Ingested much later AND started in July: outside June's window on
    // the axis the adapter filters by.
    await seed('m-2', new Date('2026-07-03T10:00:00Z'), new Date('2026-07-03T12:00:00Z'), 100_000);

    const juneWatermark = await repository.ingestionWatermark(
      JUNE_START,
      JULY_START,
    );

    expect(juneWatermark?.toISOString()).toBe('2026-06-10T12:00:00.000Z');
  });
});
