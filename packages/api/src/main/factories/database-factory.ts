import { config } from '../../infrastructure/index.js';
import { MongoDb } from '../../infrastructure/database/index.js';
import {
  Database,
  MigrationRunner,
} from '../../infrastructure/interfaces/index.js';
import { runMigrations } from '../../infrastructure/database/mongodb/helpers/migration-runner.js';
import { migrations } from '../../infrastructure/database/mongodb/migrations/index.js';

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
