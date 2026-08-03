import { ListSessionsController } from '../../presentation/controllers/sessions/list-sessions-controller.js';
import { GetSessionDetailController } from '../../presentation/controllers/sessions/get-session-detail-controller.js';
import { ListSessionFilterOptionsController } from '../../presentation/controllers/sessions/list-session-filter-options-controller.js';
import { ListSessionsDbUseCase } from '../../application/useCases/querySessions/list-sessions-db-use-case.js';
import { GetSessionDetailDbUseCase } from '../../application/useCases/querySessions/get-session-detail-db-use-case.js';
import { ListSessionFilterOptionsDbUseCase } from '../../application/useCases/querySessions/list-session-filter-options-db-use-case.js';
import { MongoDbSessionQueryRepository } from '@khal/core/infrastructure/database/mongodb/session/mongodb-session-query-repository.js';
import { config } from '../../infrastructure/index.js';

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

export const makeListSessionFilterOptionsController =
  (): ListSessionFilterOptionsController =>
    new ListSessionFilterOptionsController({
      listSessionFilterOptions: new ListSessionFilterOptionsDbUseCase({
        sessionQueryRepository: new MongoDbSessionQueryRepository(),
        // Dropdown decoration: ≤10s staleness accepted (decision 77
        // precedent); 0 in tests so route asserts see ground truth.
        cacheTtlMs: config.Environment === 'test' ? 0 : 10_000,
      }),
    });
