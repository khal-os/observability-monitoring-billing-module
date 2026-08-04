import { MongoDb } from '@observability/core/infrastructure/database/mongodb/mongo-db.js';
import {
  MIGRATIONS_COLLECTION,
  runMigrations,
} from '@observability/core/infrastructure/database/mongodb/helpers/migration-runner.js';
import { migrations } from '@observability/core/infrastructure/database/mongodb/migrations/index.js';
import {
  MongoDbPriceVersionRepository,
  PRICE_VERSIONS_COLLECTION,
} from '@observability/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { seedPocPrices } from '@observability/core/infrastructure/database/mongodb/priceVersion/poc-price-seed.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import {
  BILLING_PERIODS_COLLECTION,
  MongoDbBillingPeriodRepository,
} from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { TRACES_COLLECTION } from '@observability/core/infrastructure/database/mongodb/collections.js';
import { SyncTracesDbUseCase } from '../../../application/useCases/syncTraces/sync-traces-db-use-case.js';
import { FakeTraceSourceClient } from '../../traceSource/fake-trace-source-client.js';
import { MongoDbIngestFailureRepository } from './ingestFailures/mongodb-ingest-failure-repository.js';
import { estimateBsonBytes } from './ingestFailures/bson-size-estimator.js';

/**
 * The CONNECTOR's write path against a REAL store (audit E-3): this
 * package builds the image that ingests, yet its whole suite ran against
 * in-memory stubs — `npm test -w @observability/connector` was green while
 * insertIfAbsent's transactional write, the stamp at ingestion and the
 * idempotent re-sync had never touched a database from here. The
 * cross-package acceptance flows (billing lifecycle, invariant 3 over
 * HTTP) stay in the module, where they belong; what THIS suite owns is
 * the write path the connector image ships.
 */
const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');
const JULY_1 = new Date('2026-07-01T00:00:00.000Z');

const makeSut = () =>
  new SyncTracesDbUseCase({
    traceSourceClient: new FakeTraceSourceClient(),
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    ingestFailureRepository: new MongoDbIngestFailureRepository(),
    estimateDocumentBytes: estimateBsonBytes,
  });

describe('Connector write path against the real store (audit E-3)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env['MONGO_URL'] as string);
  });

  beforeEach(async () => {
    for (const collection of [
      TRACES_COLLECTION,
      PRICE_VERSIONS_COLLECTION,
      MIGRATIONS_COLLECTION,
      BILLING_PERIODS_COLLECTION,
    ]) {
      await MongoDb.getCollection(collection).deleteMany({});
    }

    await runMigrations(MongoDb.getClient().db(), migrations);
    await seedPocPrices(MongoDb.getClient().db());
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST ingest the fixture window stamped at write time — and re-syncing it MUST change nothing (idempotency)', async () => {
    const sut = makeSut();

    const first = await sut.sync({ from: JUNE_1, to: JULY_1 });

    expect(first.inserted).toBeGreaterThan(0);
    expect(first.failed).toBe(0);

    const stored = await MongoDb.getCollection(TRACES_COLLECTION)
      .find({ pricingStatus: 'stamped' })
      .toArray();

    // Stamp at write time (invariant 1): every stamped trace carries its
    // applied prices and an exact total.
    for (const trace of stored) {
      expect(Array.isArray(trace['stampedCosts'])).toBe(true);
      expect(typeof trace['totalCostMicrocents']).toBe('number');
      expect(trace['totalCostMicrocents']).toBeGreaterThan(0);
    }

    const second = await sut.sync({ from: JUNE_1, to: JULY_1 });

    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(first.inserted);

    const countAfter = await MongoDb.getCollection(
      TRACES_COLLECTION,
    ).countDocuments();

    // The unique traceId index IS the idempotency mechanism (audit G-2) —
    // the same window twice must never double-store.
    expect(countAfter).toBe(first.inserted);
  });

  it('MUST refuse to run against a store missing the unique traceId index — never double-count silently (audit G-2)', async () => {
    // A fresh database whose migrations never ran: the exact state the
    // documented-deploy race (G-2) produces. The write path's own guard
    // is what makes every operator ordering safe.
    await MongoDb.getCollection(TRACES_COLLECTION).drop();

    const { assertIngestionIndexes } = await import(
      '@observability/core/infrastructure/database/mongodb/helpers/assert-ingestion-indexes.js'
    );

    await expect(assertIngestionIndexes()).rejects.toThrow(/make migrate/);
  });
});
