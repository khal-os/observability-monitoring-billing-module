import { ExecutionStatus, TraceModel } from '../models/trace-model.js';
import { Paginated, Pagination } from '../models/pagination.js';

/**
 * List fields are OR within themselves and AND across fields — they come
 * from repeated query params (?agent=a&agent=b), decision 76.
 */
export interface TraceListFilters {
  /** Inclusive start of the period filter. */
  from?: Date;
  /** Exclusive end of the period filter. */
  to?: Date;
  agentIds?: string[];
  status?: ExecutionStatus;
  types?: string[];
  /** Matches the channel TYPE (whatsapp/web/...). */
  channels?: string[];
  domains?: string[];
  subdomains?: string[];
  /** Exact match on trace id OR session id. */
  search?: string;
}

export interface ListTracesUseCase {
  list(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>>;
}
