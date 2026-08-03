import { makeReprocessPendingUseCase } from '../factories/reprocess-factory.js';
import { makeDatabase } from '../factories/database-factory.js';

/**
 * US3 companion job: stamps pending_price traces after the missing price
 * is registered (npm run price:insert). Same as-of stamping rule as the
 * sync (// QA19 in the use case).
 */
const database = makeDatabase();

await database.connect();

try {
  await makeReprocessPendingUseCase().reprocess();
} finally {
  await database.disconnect();
}
