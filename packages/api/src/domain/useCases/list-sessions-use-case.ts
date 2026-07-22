import { ExecutionStatus } from '../models/trace-model.js';
import { SessionSummaryModel } from '../models/session-model.js';
import { Paginated, Pagination } from '../models/pagination.js';

export interface SessionListFilters {
  // QA17: the period filter selects sessions by their START time — a
  // session that crosses the period border stays whole in its start period.
  /** Inclusive start. */
  from?: Date;
  /** Exclusive end. */
  to?: Date;
  agentId?: string;
  status?: ExecutionStatus;
}

export interface ListSessionsUseCase {
  list(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>>;
}
