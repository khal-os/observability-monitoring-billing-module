import { MongoDb } from '../../../../../infrastructure/database/mongodb/mongo-db.js';
import {
  MIGRATIONS_COLLECTION,
  runMigrations,
} from '../../../../../infrastructure/database/mongodb/helpers/migration-runner.js';
import { migrations } from '../../../../../infrastructure/database/mongodb/migrations/index.js';
import { seedPocPrices } from '../../../../../infrastructure/database/mongodb/priceVersion/poc-price-seed.js';
import { PRICE_VERSIONS_COLLECTION } from '../../../../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import {
  SESSION_SUMMARIES_COLLECTION,
  TRACES_COLLECTION,
  TRACE_FILTER_COUNTERS_COLLECTION,
} from '../../../../../infrastructure/database/mongodb/collections.js';
import { BILLING_PERIODS_COLLECTION } from '../../../../../infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import {
  BILLING_SNAPSHOTS_COLLECTION,
  BILLING_SNAPSHOT_USAGE_COLLECTION,
} from '../../../../../infrastructure/database/mongodb/billing/mongodb-billing-snapshot-repository.js';
import { makeSyncTracesUseCase } from '../../../../factories/sync-factory.js';
import { StampedTokenCost } from '../../../../../domain/models/trace-model.js';

/**
 * THE single storage-aware helper behind the route suites. The HTTP-level
 * tests are storage-blind: everything they need from the store — lifecycle,
 * reset+migrate, the ingested-June fixture state, and the raw reads that
 * power the MANDATORY invariant-3 independent recomputation — comes through
 * here. Swapping the storage backend means rewriting THIS file only; the
 * suites and their assertions stay untouched.
 */

/** Raw stored trace, as the independent consistency checks consume it. */
export interface StoredTraceRecord {
  traceId: string;
  agent?: { id?: string; version?: string };
  model?: { id: string; provider: string | null };
  pricingStatus: string;
  startedAt: Date;
  stampedCosts?: StampedTokenCost[];
  totalCostMicrocents?: number;
}

export const routeDbHarness = {
  connect: (): Promise<void> =>
    MongoDb.connectWithUri(process.env.MONGO_URL as string),

  disconnect: (): Promise<void> => MongoDb.disconnect(),

  resetAndMigrate: async (): Promise<void> => {
    for (const collection of [
      TRACES_COLLECTION,
      TRACE_FILTER_COUNTERS_COLLECTION,
      SESSION_SUMMARIES_COLLECTION,
      PRICE_VERSIONS_COLLECTION,
      MIGRATIONS_COLLECTION,
      // Billing lifecycle state too: suites that close/reopen periods run
      // in the SAME database (--runInBand), so a leftover closed June from
      // another suite would silently flip period_status/snapshot answers
      // here. Pristine means no periods, no snapshots, no snapshot usage.
      BILLING_PERIODS_COLLECTION,
      BILLING_SNAPSHOTS_COLLECTION,
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    ]) {
      await MongoDb.getCollection(collection).deleteMany({});
    }

    await runMigrations(MongoDb.getClient().db(), migrations);
    // Prices are no longer seeded by the migration chain (decision 74) —
    // the harness seeds them explicitly, like `make seed-prices` does in dev.
    await seedPocPrices(MongoDb.getClient().db());
  },

  /**
   * The pristine fixture state every route suite starts from: clean store,
   * migrations + the PoC price seed, then the two June sync windows
   * ingested through the real pipeline (fixture-backed source client).
   */
  ingestJuneFixtures: async (): Promise<void> => {
    await routeDbHarness.resetAndMigrate();

    const sync = makeSyncTracesUseCase();

    await sync.sync({
      from: new Date('2026-06-01T00:00:00.000Z'),
      to: new Date('2026-06-15T00:00:00.000Z'),
    });
    await sync.sync({
      from: new Date('2026-06-15T00:00:00.000Z'),
      to: new Date('2026-07-01T00:00:00.000Z'),
    });
  },

  /**
   * Raw trace read for the independent recomputation (invariant 3): on
   * purpose NOT the billing aggregation path — plain records, half-open
   * [from, to) on startedAt.
   */
  readTracesBetween: async (
    from: Date,
    to: Date,
  ): Promise<StoredTraceRecord[]> =>
    (await MongoDb.getCollection(TRACES_COLLECTION)
      .find({ startedAt: { $gte: from, $lt: to } })
      .toArray()) as unknown as StoredTraceRecord[],
};
