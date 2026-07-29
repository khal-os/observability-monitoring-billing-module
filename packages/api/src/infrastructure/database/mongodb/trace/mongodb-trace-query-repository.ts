import { Document, Filter } from 'mongodb';
import { TraceQueryRepository } from '../../../../application/interfaces/trace-query-repository.js';
import { TraceListFilters } from '../../../../domain/useCases/list-traces-use-case.js';
import { TraceFilterOptions } from '../../../../domain/useCases/list-trace-filter-options-use-case.js';
import { Paginated, Pagination } from '../../../../domain/models/pagination.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from './mongodb-trace-repository.js';

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

  return filter;
};

export class MongoDbTraceQueryRepository implements TraceQueryRepository {
  async findTraces(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const filter = buildFilter(filters);

    const [items, total] = await Promise.all([
      traces
        .find(filter, {
          // Detail-heavy fields stay out of list responses (decision 47).
          projection: { input: 0, output: 0, spans: 0 },
        })
        .sort({ startedAt: -1, traceId: 1 })
        .skip((pagination.page - 1) * pagination.pageSize)
        .limit(pagination.pageSize)
        .toArray(),
      traces.countDocuments(filter),
    ]);

    return {
      items: items as unknown as TraceModel[],
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
    };
  }

  async findTraceDetail(traceId: string): Promise<TraceModel | null> {
    // The whole anatomy in a single read (decision 47).
    const trace = await MongoDb.getCollection(TRACES_COLLECTION).findOne({
      traceId,
    });

    return trace as unknown as TraceModel | null;
  }

  // QA15: unfiltered distincts ride DISTINCT_SCAN on the field-led indexes
  // (migrations 003 + 012). If cascaded facets get slow at real volume, the
  // fallback is precomputing the unfiltered options at ingestion and keeping
  // live queries only for cascaded requests.
  async findFilterOptions(
    filters: TraceListFilters,
  ): Promise<TraceFilterOptions> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    const distinctFor = async (
      field: string,
      selfKey: keyof TraceListFilters,
    ): Promise<string[]> => {
      // Self-exclusion cascade (see TraceQueryRepository.findFilterOptions).
      const match = buildFilter({ ...filters, [selfKey]: undefined });

      // Optional fields are stored as null, never absent — keep them out.
      match[field] = { $ne: null };

      const values = await traces.distinct(field, match);

      return (values as string[]).sort();
    };

    const [domains, subdomains, types, agents, channels] = await Promise.all([
      distinctFor('domain', 'domains'),
      distinctFor('subdomain', 'subdomains'),
      distinctFor('type', 'types'),
      distinctFor('agent.id', 'agentIds'),
      distinctFor('channel.type', 'channels'),
    ]);

    return { domains, subdomains, types, agents, channels };
  }
}
