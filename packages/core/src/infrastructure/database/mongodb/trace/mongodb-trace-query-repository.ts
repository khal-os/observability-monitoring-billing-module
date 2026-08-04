import { Document, Filter } from 'mongodb';
import { TraceQueryRepository } from '../../../../application/interfaces/trace-query-repository.js';
import { TraceListFilters } from '../../../../domain/useCases/list-traces-use-case.js';
import {
  TraceFilterOption,
  TraceFilterOptions,
} from '../../../../domain/useCases/list-trace-filter-options-use-case.js';
import { utcDayOf } from '../../../../domain/models/filter-counter-model.js';
import {
  MAX_PAGINATION_SKIP,
  Paginated,
  Pagination,
} from '../../../../domain/models/pagination.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { TRACE_FILTER_COUNTERS_COLLECTION } from '../collections.js';

/**
 * Exact totals on arbitrary filter combos are O(matching docs) — counting
 * stops here and displays show "10.000+" (decision 77, measured at 1M).
 * Shared with the presentation-layer depth guard (decision 79): the pages
 * a client can navigate to and the documents we are willing to count are
 * the same horizon.
 */
export const TOTAL_CAP = MAX_PAGINATION_SKIP;

const buildFilter = (filters: TraceListFilters): Filter<Document> => {
  const filter: Filter<Document> = {};

  if (filters.from || filters.to) {
    filter['startedAt'] = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lt: filters.to } : {}),
    };
  }

  if (filters.agentIds) filter['agent.id'] = { $in: filters.agentIds };
  if (filters.status) filter['status'] = filters.status;
  if (filters.types) filter['type'] = { $in: filters.types };
  if (filters.channels) filter['channel.type'] = { $in: filters.channels };
  if (filters.domains) filter['domain'] = { $in: filters.domains };
  if (filters.subdomains) filter['subdomain'] = { $in: filters.subdomains };

  if (filters.search) {
    filter['$or'] = [
      { traceId: filters.search },
      { sessionId: filters.search },
    ];
  }

  // audit D-9: the UNRESOLVED-quarantine lens (decision 100/115) — the
  // same predicate countQuarantined uses, so the bill's count and this
  // list can never disagree about which traces it means. Rides migration
  // 021's partial index on the true branch.
  if (filters.quarantined === true) {
    filter['billingQuarantine.reason'] = { $exists: true };
    filter['billingQuarantine.absorbedInSnapshotVersion'] = { $exists: false };
  } else if (filters.quarantined === false) {
    filter['$and'] = [
      ...((filter['$and'] as Filter<Document>[] | undefined) ?? []),
      {
        $or: [
          { 'billingQuarantine.reason': { $exists: false } },
          { 'billingQuarantine.absorbedInSnapshotVersion': { $exists: true } },
        ],
      },
    ];
  }

  return filter;
};

/** Facet field ↔ its counter-cube dimension and its self-exclusion key. */
const FACET_FIELDS = [
  { option: 'domains', dim: 'domain', selfKey: 'domains' },
  { option: 'subdomains', dim: 'subdomain', selfKey: 'subdomains' },
  { option: 'types', dim: 'type', selfKey: 'types' },
  { option: 'agents', dim: 'agentId', selfKey: 'agentIds' },
  { option: 'channels', dim: 'channelType', selfKey: 'channels' },
  { option: 'statuses', dim: 'status', selfKey: 'status' },
] as const;

/**
 * The counter cube keys days, not timestamps: a facet period is rounded
 * OUT to whole UTC days (floor(from), ceil(to)) — documented contract of
 * GET /traces/filters (decision 77). The list keeps exact timestamps.
 */
const buildCounterMatch = (filters: TraceListFilters): Filter<Document> => {
  const match: Filter<Document> = {};

  if (filters.from || filters.to) {
    const from = filters.from ? utcDayOf(filters.from) : undefined;
    const to = filters.to
      ? filters.to.getTime() === utcDayOf(filters.to).getTime()
        ? filters.to
        : new Date(utcDayOf(filters.to).getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    match['day'] = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lt: to } : {}),
    };
  }

  if (filters.agentIds) match['agentId'] = { $in: filters.agentIds };
  if (filters.status) match['status'] = filters.status;
  if (filters.types) match['type'] = { $in: filters.types };
  if (filters.channels) match['channelType'] = { $in: filters.channels };
  if (filters.domains) match['domain'] = { $in: filters.domains };
  if (filters.subdomains) match['subdomain'] = { $in: filters.subdomains };

  return match;
};

export class MongoDbTraceQueryRepository implements TraceQueryRepository {
  async findTraces(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const filter = buildFilter(filters);
    const unfiltered = Object.keys(filter).length === 0;

    const [items, rawTotal] = await Promise.all([
      traces
        .find(filter, {
          // Detail-heavy fields stay out of list responses (decision 47).
          projection: { input: 0, output: 0, spans: 0 },
        })
        .sort({ startedAt: -1, traceId: 1 })
        .skip((pagination.page - 1) * pagination.pageSize)
        .limit(pagination.pageSize)
        .toArray(),
      // Unfiltered: collection metadata — O(1), but APPROXIMATE: the
      // metadata count can drift after an unclean mongod shutdown (and
      // counts orphans on sharded topologies) until validate/repair
      // corrects it. Acceptable for an unfiltered list total; anything
      // money-bearing counts real documents. Filtered: count up to the
      // cap and stop (decision 77).
      unfiltered
        ? traces.estimatedDocumentCount()
        : traces.countDocuments(filter, { limit: TOTAL_CAP + 1 }),
    ]);

    // The cap applies to BOTH branches — the unfiltered count is cheap, but
    // the horizon is shared with the depth guard (decision 79), and the
    // controller derives total_pages from this total. Reporting the true
    // 50.000 on an unfiltered archive (invariant 6: it grows past the cap
    // by design) advertised 2.500 pages of which the API served 500: page
    // 501 answered 400 and the UI's "Próxima" painted an outage that was
    // not happening. Same rule the sessions repository already applies.
    const totalCapped = rawTotal > TOTAL_CAP;

    return {
      items: items as unknown as TraceModel[],
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: totalCapped ? TOTAL_CAP : rawTotal,
      totalCapped,
    };
  }

  async findTraceDetail(traceId: string): Promise<TraceModel | null> {
    // The whole anatomy in a single read (decision 47).
    const trace = await MongoDb.getCollection(TRACES_COLLECTION).findOne({
      traceId,
    });

    return trace as unknown as TraceModel | null;
  }

  async findFilterOptions(
    filters: TraceListFilters,
  ): Promise<TraceFilterOptions> {
    // `search` is not a cube dimension — but it matches at most a
    // handful of traces (exact ids), so the live path stays trivial.
    if (filters.search) {
      return this.findFilterOptionsLive(filters);
    }

    const counters = MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION);

    const optionsFor = async (
      dim: string,
      selfKey: keyof TraceListFilters,
    ): Promise<TraceFilterOption[]> => {
      // Self-exclusion cascade (see TraceQueryRepository.findFilterOptions):
      // each count answers "how many traces if I picked this value". With
      // no other filters the {dim, count} indexes make this an index-only
      // scan; cascaded matches fall back to scanning the (narrow) subset.
      const match = buildCounterMatch({ ...filters, [selfKey]: undefined });
      match[dim] = { $ne: null };

      const rows = await counters
        .aggregate([
          { $match: match },
          { $group: { _id: `$${dim}`, count: { $sum: '$count' } } },
          // Attribution deltas may leave zero-count tuples behind.
          { $match: { count: { $gt: 0 } } },
          { $sort: { _id: 1 } },
        ])
        .toArray();

      return rows.map((row) => ({
        value: row['_id'] as string,
        count: row['count'] as number,
      }));
    };

    const [domains, subdomains, types, agents, channels, statuses] =
      await Promise.all(
        FACET_FIELDS.map((field) => optionsFor(field.dim, field.selfKey)),
      );

    return { domains, subdomains, types, agents, channels, statuses };
  }

  /** Trace-collection fallback for filters the cube cannot answer. */
  private async findFilterOptionsLive(
    filters: TraceListFilters,
  ): Promise<TraceFilterOptions> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    const tracePathOf: Record<string, string> = {
      domain: 'domain',
      subdomain: 'subdomain',
      type: 'type',
      agentId: 'agent.id',
      channelType: 'channel.type',
      status: 'status',
    };

    const optionsFor = async (
      dim: string,
      selfKey: keyof TraceListFilters,
    ): Promise<TraceFilterOption[]> => {
      const field = tracePathOf[dim];
      const match = buildFilter({ ...filters, [selfKey]: undefined });
      match[field] = { $ne: null };

      const rows = await traces
        .aggregate([
          { $match: match },
          { $group: { _id: `$${field}`, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .toArray();

      return rows.map((row) => ({
        value: row['_id'] as string,
        count: row['count'] as number,
      }));
    };

    const [domains, subdomains, types, agents, channels, statuses] =
      await Promise.all(
        FACET_FIELDS.map((field) => optionsFor(field.dim, field.selfKey)),
      );

    return { domains, subdomains, types, agents, channels, statuses };
  }
}
