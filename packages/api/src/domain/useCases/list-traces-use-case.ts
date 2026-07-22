import { ExecutionStatus, TraceModel } from '../models/trace-model.js';
import { Paginated, Pagination } from '../models/pagination.js';

export interface TraceListFilters {
  /** Inclusive start of the period filter. */
  from?: Date;
  /** Exclusive end of the period filter. */
  to?: Date;
  agentId?: string;
  status?: ExecutionStatus;
  type?: string;
  /** Matches the channel TYPE (whatsapp/web/...). */
  channel?: string;
  domain?: string;
  subdomain?: string;
  /** Exact match on trace id OR session id. */
  search?: string;
}

export interface ListTracesUseCase {
  list(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>>;
}
