import {
  ListSessionsUseCase,
  Paginated,
  Pagination,
  SessionListFilters,
  SessionQueryRepository,
} from './query-sessions-protocols.js';
import { SessionSummaryModel } from '../../../domain/models/session-model.js';

export class ListSessionsDbUseCase implements ListSessionsUseCase {
  private readonly sessionQueryRepository: SessionQueryRepository;

  constructor(args: { sessionQueryRepository: SessionQueryRepository }) {
    this.sessionQueryRepository = args.sessionQueryRepository;
  }

  async list(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>> {
    return this.sessionQueryRepository.findSessions(filters, pagination);
  }
}
