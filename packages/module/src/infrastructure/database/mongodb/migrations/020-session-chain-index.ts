import { Migration, dropIndexIfExists } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * audit C-7.6: the session-detail chain read sorts by
 * `{startedAt: 1, traceId: 1}` within a session (deterministic tiebreak,
 * same rule as the summary pipeline's $top), but 003's
 * `{sessionId: 1, startedAt: 1}` index stops one key short — every chain
 * read pays an in-memory sort of the session's traces. Same shape rule as
 * decision 77 ("every filter index ends in the FULL sort key"), same
 * supersede pattern as 013: extend the index, drop the narrower one.
 */
export const sessionChainIndex: Migration = {
  id: '020-session-chain-index',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await traces.createIndex({ sessionId: 1, startedAt: 1, traceId: 1 });

    await dropIndexIfExists(traces, { sessionId: 1, startedAt: 1 });
  },
};
