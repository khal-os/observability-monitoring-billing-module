import { config } from '../../infrastructure/index.js';
import { MongoDb } from '@observability/core/infrastructure/database/index.js';
import { Database } from '@observability/core/infrastructure/interfaces/database.js';
import { makeLogger } from './logger-factory.js';

/**
 * THE storage seam of the connector runtime (decision 56): the worker and
 * the manual sync job consume the Database port; the concrete backend is
 * named only here. Migrations stay with the module — the connector writes
 * into a store whose schema the module owns.
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
