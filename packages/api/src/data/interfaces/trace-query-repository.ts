import { TraceListFilters } from '../../core/useCases/list-traces-use-case.js';
import { TraceModel } from '../../core/models/trace-model.js';
import { Paginated, Pagination } from '../../core/models/pagination.js';

export interface TraceQueryRepository {
  /** Server-side filters, pagination and ordering (most recent first). */
  findTraces(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>>;

  /** The self-contained trace document — spans and payloads included. */
  findTraceDetail(traceId: string): Promise<TraceModel | null>;
}
