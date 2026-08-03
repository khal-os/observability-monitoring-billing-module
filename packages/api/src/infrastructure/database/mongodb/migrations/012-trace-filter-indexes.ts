import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * Filter-bar facets (GET /traces/filters): an unfiltered distinct('x')
 * only rides a DISTINCT_SCAN when an index has x as its FIRST key. 003
 * already leads with agent.id, type and domain; these close the gaps —
 * channel.type also serves the channel list filter, which had no index.
 */
export const traceFilterIndexes: Migration = {
  id: '012-trace-filter-indexes',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await traces.createIndex({ 'channel.type': 1, startedAt: -1 });
    await traces.createIndex({ subdomain: 1, startedAt: -1 });
  },
};
