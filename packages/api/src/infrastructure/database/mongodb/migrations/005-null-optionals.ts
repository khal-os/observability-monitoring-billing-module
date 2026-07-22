import { Collection, Document } from 'mongodb';
import { Migration } from '../helpers/migration-runner.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';
import {
  LEGACY_SPANS_COLLECTION,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';

/**
 * Storage convention: optional fields are stored as NULL, never absent —
 * any document sampled in the DB shows the full schema. Backfills nulls
 * on documents written before the convention. Idempotent (filters only
 * match documents where the field is missing). Attribution-level rewrite
 * only — price stamps keep their exact values.
 */
const backfill = async (
  collection: Collection<Document>,
  fields: string[],
): Promise<void> => {
  for (const field of fields) {
    await collection.updateMany(
      { [field]: { $exists: false } },
      { $set: { [field]: null } },
    );
  }
};

export const nullOptionals: Migration = {
  id: '005-null-optionals',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await backfill(traces, [
      'sessionId',
      'agent',
      'model',
      'domain',
      'subdomain',
      'stampedCosts',
      'totalCostMicrocents',
      'stampedAt',
      'pendingPrice',
      'unclassified',
      'tokens.input',
      'tokens.output',
      'tokens.cache_read',
      'tokens.cache_write',
    ]);

    // Nested block subfields (only where the block itself exists).
    for (const field of ['agent.version', 'agent.instance']) {
      await traces.updateMany(
        { agent: { $type: 'object' }, [field]: { $exists: false } },
        { $set: { [field]: null } },
      );
    }

    for (const field of ['channel.version', 'channel.instance']) {
      await traces.updateMany(
        { channel: { $type: 'object' }, [field]: { $exists: false } },
        { $set: { [field]: null } },
      );
    }

    await backfill(db.collection(LEGACY_SPANS_COLLECTION), ['errorMessage', 'tokens']);

    await backfill(db.collection(PRICE_VERSIONS_COLLECTION), [
      'marketPriceUsd',
      'ptaxReference',
      'markupPercent',
    ]);
  },
};
