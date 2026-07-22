import { Document, Filter } from 'mongodb';
import { TraceQueryRepository } from '../../../../application/interfaces/trace-query-repository.js';
import { TraceListFilters } from '../../../../domain/useCases/list-traces-use-case.js';
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

  if (filters.agentId) filter['agent.id'] = filters.agentId;
  if (filters.status) filter['status'] = filters.status;
  if (filters.type) filter['type'] = filters.type;
  if (filters.channel) filter['channel.type'] = filters.channel;
  if (filters.domain) filter['domain'] = filters.domain;
  if (filters.subdomain) filter['subdomain'] = filters.subdomain;

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
}
