import { config } from '../../infrastructure/index.js';
import { MongoDb } from '../../infrastructure/database/index.js';
import {
  Database,
  MigrationRunner,
} from '../../infrastructure/interfaces/index.js';
import { runMigrations } from '../../infrastructure/database/mongodb/helpers/migration-runner.js';
import { migrations } from '../../infrastructure/database/mongodb/migrations/index.js';
import {
  POC_PRICE_VERSIONS,
  seedPocPrices,
} from '../../infrastructure/database/mongodb/priceVersion/poc-price-seed.js';
import { MongoDbFilterCounterRepository } from '../../infrastructure/database/mongodb/filterCounter/mongodb-filter-counter-repository.js';

/**
 * THE storage seam: the only place (besides this factory file) that names a
 * concrete database backend. Entry points consume the Database and
 * MigrationRunner ports; swapping MongoDB for another store means swapping
 * the wiring below — nothing else in main changes (decoupling audit,
 * decision 56).
 */
export const makeDatabase = (): Database => ({
  connect: () => MongoDb.connect(config),
  disconnect: () => MongoDb.disconnect(),
});

export const makeMigrationRunner = (): MigrationRunner => ({
  run: () => runMigrations(MongoDb.getClient().db(), migrations),
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

/** DEV-ONLY PoC price seeder (decision 74) — see main/jobs/seed-poc-prices.ts. */
export const makePocPriceSeeder = (): {
  run: () => Promise<{ inserted: number; total: number }>;
} => ({
  run: async () => ({
    inserted: await seedPocPrices(MongoDb.getClient().db()),
    total: POC_PRICE_VERSIONS.length,
  }),
});
