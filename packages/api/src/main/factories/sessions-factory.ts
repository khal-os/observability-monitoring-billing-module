import { ListSessionsController } from '../../presentation/controllers/sessions/list-sessions-controller.js';
import { GetSessionDetailController } from '../../presentation/controllers/sessions/get-session-detail-controller.js';
import { ListSessionsDbUseCase } from '../../application/useCases/querySessions/list-sessions-db-use-case.js';
import { GetSessionDetailDbUseCase } from '../../application/useCases/querySessions/get-session-detail-db-use-case.js';
import { MongoDbSessionQueryRepository } from '../../infrastructure/database/mongodb/session/mongodb-session-query-repository.js';

export const makeListSessionsController = (): ListSessionsController =>
  new ListSessionsController({
    listSessions: new ListSessionsDbUseCase({
      sessionQueryRepository: new MongoDbSessionQueryRepository(),
    }),
  });

export const makeGetSessionDetailController = (): GetSessionDetailController =>
  new GetSessionDetailController({
    getSessionDetail: new GetSessionDetailDbUseCase({
      sessionQueryRepository: new MongoDbSessionQueryRepository(),
    }),
  });
