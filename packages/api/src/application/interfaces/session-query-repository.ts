import { SessionListFilters } from '../../domain/useCases/list-sessions-use-case.js';
import { SessionDetail } from '../../domain/useCases/get-session-detail-use-case.js';
import { SessionFilterOptions } from '../../domain/useCases/list-session-filter-options-use-case.js';
import { SessionSummaryModel } from '../../domain/models/session-model.js';
import { Paginated, Pagination } from '../../domain/models/pagination.js';

export interface SessionQueryRepository {
  findSessions(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>>;

  findSessionDetail(sessionId: string): Promise<SessionDetail | null>;

  /**
   * Dropdown options with what-if counts, self-excluded per field: the
   * agent options honor every filter EXCEPT agent, the status options
   * every filter EXCEPT status (decision 76 semantics over sessions).
   */
  findSessionFilterOptions(
    filters: SessionListFilters,
  ): Promise<SessionFilterOptions>;
}
