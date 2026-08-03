import { Migration } from '../helpers/migration-runner.js';
import { BILLING_PERIODS_COLLECTION } from '../billing/mongodb-billing-period-repository.js';
import {
  BILLING_SNAPSHOTS_COLLECTION,
  BILLING_SNAPSHOT_USAGE_COLLECTION,
} from '../billing/mongodb-billing-snapshot-repository.js';

/**
 * T6 constraints, enforced by the database:
 * - one lifecycle document per month;
 * - snapshots immutable and unique per (year, month, version) — a re-close
 *   after reopen writes a NEW version, never overwrites;
 * - usage records fetched by their snapshot key (reproducibility reads).
 */
export const billingPeriodIndexes: Migration = {
  id: '017-billing-period-indexes',

  async run(db) {
    await db
      .collection(BILLING_PERIODS_COLLECTION)
      .createIndex({ year: 1, month: 1 }, { unique: true });

    await db
      .collection(BILLING_SNAPSHOTS_COLLECTION)
      .createIndex({ year: 1, month: 1, version: 1 }, { unique: true });

    await db
      .collection(BILLING_SNAPSHOT_USAGE_COLLECTION)
      .createIndex({ snapshotKey: 1, traceId: 1 }, { unique: true });
  },
};
