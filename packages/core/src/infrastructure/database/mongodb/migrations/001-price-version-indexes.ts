import { Migration } from '../helpers/migration-runner.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';

/**
 * T4 constraint: price versions are immutable and unique per
 * (model, tokenType, effectiveFrom) — enforced by the database.
 */
export const priceVersionIndexes: Migration = {
  id: '001-price-version-indexes',

  async run(db) {
    await db
      .collection(PRICE_VERSIONS_COLLECTION)
      .createIndex(
        { model: 1, tokenType: 1, effectiveFrom: 1 },
        { unique: true },
      );
  },
};
