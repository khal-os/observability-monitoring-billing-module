import { Migration, dropIndexIfExists } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';
import { TRACE_FILTER_COUNTERS_COLLECTION } from '../filterCounter/mongodb-filter-counter-repository.js';

/**
 * QA15 answer, measured at 1M docs: the list sort is
 * `{startedAt: -1, traceId: 1}` (stable pagination), and an index that
 * stops at startedAt forces a COLLSCAN + in-memory top-k (~26s). Every
 * filter index therefore ends in the FULL sort key. `domain` also gets a
 * single-field-led index: in `{domain, subdomain, startedAt}` the
 * subdomain key sits between the equality and the sort, blocking it.
 *
 * Also bootstraps the `trace_filter_counters` read-model (decision 77):
 * the unique tuple index doubles as the $inc upsert key.
 */
export const sortAlignedTraceIndexes: Migration = {
  id: '013-sort-aligned-trace-indexes',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    const superseded = [
      { startedAt: -1 },
      { 'agent.id': 1, startedAt: -1 },
      { status: 1, startedAt: -1 },
      { type: 1, startedAt: -1 },
      { 'channel.type': 1, startedAt: -1 },
      { subdomain: 1, startedAt: -1 },
      { domain: 1, subdomain: 1, startedAt: -1 },
    ];
    for (const spec of superseded) {
      // Fresh deployments never created these (this migration runs right
      // after 003/012 in one chain) — hence the existence check. Only
      // "index not found" is expected; anything else rethrows (C-7.6).
      await dropIndexIfExists(traces, spec);
    }

    await traces.createIndex({ startedAt: -1, traceId: 1 });
    await traces.createIndex({ 'agent.id': 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({ status: 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({ type: 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({ 'channel.type': 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({ domain: 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({ subdomain: 1, startedAt: -1, traceId: 1 });
    await traces.createIndex({
      domain: 1,
      subdomain: 1,
      startedAt: -1,
      traceId: 1,
    });

    const counters = db.collection(TRACE_FILTER_COUNTERS_COLLECTION);

    await counters.createIndex(
      {
        day: 1,
        domain: 1,
        subdomain: 1,
        type: 1,
        agentId: 1,
        channelType: 1,
        status: 1,
      },
      { unique: true },
    );

    // One {dim, count} index per facet dimension: the UNFILTERED facet
    // ($match {dim: $ne null} + $group by dim summing count) becomes an
    // index-only scan — measured 1.5s -> sub-second over 313k tuples.
    for (const dim of [
      'domain',
      'subdomain',
      'type',
      'agentId',
      'channelType',
      'status',
    ]) {
      await counters.createIndex({ [dim]: 1, count: 1 });
    }
  },
};
