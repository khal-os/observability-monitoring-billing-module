import {
  GetSessionDetailUseCase,
  SessionDetail,
  SessionQueryRepository,
} from './query-sessions-protocols.js';

export class GetSessionDetailDbUseCase implements GetSessionDetailUseCase {
  private readonly sessionQueryRepository: SessionQueryRepository;

  constructor(args: { sessionQueryRepository: SessionQueryRepository }) {
    this.sessionQueryRepository = args.sessionQueryRepository;
  }

  async get(sessionId: string): Promise<SessionDetail | null> {
    return this.sessionQueryRepository.findSessionDetail(sessionId);
  }
}
