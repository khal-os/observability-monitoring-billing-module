import { Migration } from '../helpers/migration-runner.js';
import {
  LEGACY_SPANS_COLLECTION,
  TRACES_COLLECTION,
  LEGACY_TRACE_CONTENTS_COLLECTION,
} from '../trace/mongodb-trace-repository.js';

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
    await traces.createIndex({ agentId: 1, startedAt: -1 });
    await traces.createIndex({ status: 1, startedAt: -1 });
    await traces.createIndex({ type: 1, startedAt: -1 });
    await traces.createIndex({ sessionId: 1, startedAt: 1 });
    await traces.createIndex({ domain: 1, subdomain: 1, startedAt: -1 });
    await traces.createIndex({ pricingStatus: 1, startedAt: 1 });

    await db
      .collection(LEGACY_SPANS_COLLECTION)
      .createIndex({ traceId: 1, startedAt: 1 });

    await db
      .collection(LEGACY_TRACE_CONTENTS_COLLECTION)
      .createIndex({ traceId: 1 }, { unique: true });
  },
};
