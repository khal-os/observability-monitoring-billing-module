import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * T3: indexes shaped for the tab queries — period + agent + status +
 * domain/subdomain + type + id lookup — plus the natural-key uniqueness
 * that anchors sync idempotency.
 */
export const traceIndexes: Migration = {
  id: '003-trace-indexes',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await traces.createIndex({ traceId: 1 }, { unique: true });
    await traces.createIndex({ startedAt: -1 });
    await traces.createIndex({ 'agent.id': 1, startedAt: -1 });
    await traces.createIndex({ status: 1, startedAt: -1 });
    await traces.createIndex({ type: 1, startedAt: -1 });
    await traces.createIndex({ sessionId: 1, startedAt: 1 });
    await traces.createIndex({ domain: 1, subdomain: 1, startedAt: -1 });
    await traces.createIndex({ pricingStatus: 1, startedAt: 1 });
  },
};
