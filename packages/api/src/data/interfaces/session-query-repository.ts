import { SessionListFilters } from '../../core/useCases/list-sessions-use-case.js';
import { SessionDetail } from '../../core/useCases/get-session-detail-use-case.js';
import { SessionSummaryModel } from '../../core/models/session-model.js';
import { Paginated, Pagination } from '../../core/models/pagination.js';

export interface SessionQueryRepository {
  findSessions(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>>;

  findSessionDetail(sessionId: string): Promise<SessionDetail | null>;
}
