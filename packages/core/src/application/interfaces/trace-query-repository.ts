import { TraceListFilters } from '../../domain/useCases/list-traces-use-case.js';
import { TraceFilterOptions } from '../../domain/useCases/list-trace-filter-options-use-case.js';
import { TraceModel } from '../../domain/models/trace-model.js';
import { Paginated, Pagination } from '../../domain/models/pagination.js';

export interface TraceQueryRepository {
  /** Server-side filters, pagination and ordering (most recent first). */
  findTraces(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>>;

  /** The self-contained trace document — spans and payloads included. */
  findTraceDetail(traceId: string): Promise<TraceModel | null>;

  /**
   * Stored values + counts per filterable field, cascading with
   * SELF-EXCLUSION: field X's options honor every filter except X's own,
   * so a selected dropdown still lists its alternatives instead of
   * collapsing. Each count is a "what-if": traces matching that value
   * combined with the OTHER fields' active filters.
   */
  findFilterOptions(filters: TraceListFilters): Promise<TraceFilterOptions>;
}
