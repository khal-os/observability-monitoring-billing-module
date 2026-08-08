import { config } from '../../infrastructure/index.js';
import { MongoDb } from '@observability/core/infrastructure/database/index.js';
import {
  Database,
  MigrationRunner,
} from '../../infrastructure/interfaces/index.js';
import { runMigrations } from '@observability/core/infrastructure/database/mongodb/helpers/migration-runner.js';
import { guardConcurrentRebuild } from '@observability/core/infrastructure/database/mongodb/helpers/guard-concurrent-rebuild.js';
import { migrations } from '@observability/core/infrastructure/database/mongodb/migrations/index.js';
import {
  POC_PRICE_VERSIONS,
  seedPocPrices,
} from '@observability/core/infrastructure/database/mongodb/priceVersion/poc-price-seed.js';
import { MongoDbFilterCounterRepository } from '@observability/core/infrastructure/database/mongodb/filterCounter/mongodb-filter-counter-repository.js';
import { MongoDbSessionSummaryRepository } from '@observability/core/infrastructure/database/mongodb/session/mongodb-session-summary-repository.js';
import { makeLogger } from './logger-factory.js';

/**
 * THE storage seam: the only place (besides this factory file) that names a
 * concrete database backend. Entry points consume the Database and
 * MigrationRunner ports; swapping MongoDB for another store means swapping
 * the wiring below — nothing else in main changes (decoupling audit,
 * decision 56).
 */
export const makeDatabase = (): Database => {
  // The singleton's logger follows the client's per-process lifecycle:
  // wired by the entry point that owns connect/disconnect.
  MongoDb.useLogger(makeLogger({ component: 'mongodb' }));

  return {
    connect: () => MongoDb.connect(config),
    disconnect: () => MongoDb.disconnect(),
  };
};

export const makeMigrationRunner = (): MigrationRunner => ({
  run: () =>
    runMigrations(
      MongoDb.getClient().db(),
      migrations,
      makeLogger({ component: 'migrations' }),
    ),
});

/**
 * Facet-cube recompute (decision 77) — see main/jobs/rebuild-filter-counters.ts.
 * Returns the number of dimension tuples in the rebuilt cube.
 */
export const makeFilterCounterRebuild = (): {
  run: () => Promise<number>;
} => ({
  run: () => new MongoDbFilterCounterRepository().rebuildFromTraces(),
});

/** Sessions read-model rebuild (decision 80) — see main/jobs/rebuild-session-summaries.ts. */
export const makeSessionSummaryRebuild = (): {
  run: () => Promise<void>;
} => ({
  run: () => new MongoDbSessionSummaryRepository().rebuildFromTraces(),
});

/** DEV-ONLY PoC price seeder (decision 74) — see main/jobs/seed-poc-prices.ts. */
export const makePocPriceSeeder = (): {
  run: () => Promise<{ inserted: number; total: number }>;
} => ({
  run: async () => ({
    inserted: await seedPocPrices(MongoDb.getClient().db()),
    total: POC_PRICE_VERSIONS.length,
  }),
});

/**
 * audit F-1: the $out-swap guard, exposed HERE so the rebuild jobs reach
 * storage only through the composition root (the architecture boundary) —
 * they must not deep-import an infrastructure helper directly.
 */
export const makeRebuildGuard = (): ((
  rebuild: () => Promise<void>,
) => Promise<void>) => guardConcurrentRebuild;
