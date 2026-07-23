import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * pendingPrice.missingTokenTypes is now DERIVED AT READ TIME (the
 * deliberate exception to decision 51: its truth depends on the mutable
 * price table, so any stored copy goes stale the moment a price is
 * registered). Stored snapshots from before the change are stale data —
 * null them out; readers ignore the field and derive fresh. Idempotent:
 * only touches documents still carrying a non-null snapshot.
 */
export const nullPendingPrice: Migration = {
  id: '010-null-pending-price',

  async run(db) {
    await db
      .collection(TRACES_COLLECTION)
      .updateMany(
        { pendingPrice: { $ne: null } },
        { $set: { pendingPrice: null } },
      );
  },
};
