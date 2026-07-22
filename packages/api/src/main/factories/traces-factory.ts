import { ListTracesController } from '../../presentation/controllers/traces/list-traces-controller.js';
import { GetTraceDetailController } from '../../presentation/controllers/traces/get-trace-detail-controller.js';
import { ListTracesDbUseCase } from '../../application/useCases/queryTraces/list-traces-db-use-case.js';
import { GetTraceDetailDbUseCase } from '../../application/useCases/queryTraces/get-trace-detail-db-use-case.js';
import { MongoDbTraceQueryRepository } from '../../infrastructure/database/mongodb/trace/mongodb-trace-query-repository.js';

export const makeListTracesController = (): ListTracesController =>
  new ListTracesController({
    listTraces: new ListTracesDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
    }),
  });

export const makeGetTraceDetailController = (): GetTraceDetailController =>
  new GetTraceDetailController({
    getTraceDetail: new GetTraceDetailDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
    }),
  });
