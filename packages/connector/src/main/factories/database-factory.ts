import { config } from '../../infrastructure/index.js';
import { MongoDb } from '@khal/core/infrastructure/database/index.js';
import { Database } from '@khal/core/infrastructure/interfaces/database.js';

/**
 * THE storage seam of the connector runtime (decision 56): the worker and
 * the manual sync job consume the Database port; the concrete backend is
 * named only here. Migrations stay with the module — the connector writes
 * into a store whose schema the module owns.
 */
export const makeDatabase = (): Database => ({
  connect: () => MongoDb.connect(config),
  disconnect: () => MongoDb.disconnect(),
});
