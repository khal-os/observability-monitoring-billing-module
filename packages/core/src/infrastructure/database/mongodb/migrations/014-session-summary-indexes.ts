import { Migration } from '../helpers/migration-runner.js';
import { SESSION_SUMMARIES_COLLECTION } from '../collections.js';

/**
 * Bootstraps the materialized sessions read-model (decision 80). Same
 * shape rule as the traces list (decision 77): every filter index ends
 * in the FULL sort key `{startedAt: -1, sessionId: 1}` so no query form
 * ever pays a blocking sort. The collection itself is derived — created
 * empty here, filled by ingestion's recompute-on-touch and by
 * `make rebuild-session-summaries` on restored deployments.
 */
export const sessionSummaryIndexes: Migration = {
  id: '014-session-summary-indexes',

  async run(db) {
    const summaries = db.collection(SESSION_SUMMARIES_COLLECTION);

    await summaries.createIndex({ startedAt: -1, sessionId: 1 });
    await summaries.createIndex({ 'agent.id': 1, startedAt: -1, sessionId: 1 });
    await summaries.createIndex({ status: 1, startedAt: -1, sessionId: 1 });
  },
};
