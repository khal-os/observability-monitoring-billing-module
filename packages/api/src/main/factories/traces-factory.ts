import { ListTracesController } from '../../presentation/controllers/traces/list-traces-controller.js';
import { ListTraceFilterOptionsController } from '../../presentation/controllers/traces/list-trace-filter-options-controller.js';
import { GetTraceDetailController } from '../../presentation/controllers/traces/get-trace-detail-controller.js';
import { ListTracesDbUseCase } from '../../application/useCases/queryTraces/list-traces-db-use-case.js';
import { ListTraceFilterOptionsDbUseCase } from '../../application/useCases/queryTraces/list-trace-filter-options-db-use-case.js';
import { GetTraceDetailDbUseCase } from '../../application/useCases/queryTraces/get-trace-detail-db-use-case.js';
import { MongoDbTraceQueryRepository } from '../../infrastructure/database/mongodb/trace/mongodb-trace-query-repository.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';

// The price repository feeds the READ-TIME derivation of
// pendingPrice.missingTokenTypes (see derive-pending-price.ts).
export const makeListTracesController = (): ListTracesController =>
  new ListTracesController({
    listTraces: new ListTracesDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
    }),
  });

export const makeListTraceFilterOptionsController =
  (): ListTraceFilterOptionsController =>
    new ListTraceFilterOptionsController({
      listTraceFilterOptions: new ListTraceFilterOptionsDbUseCase({
        traceQueryRepository: new MongoDbTraceQueryRepository(),
      }),
    });

export const makeGetTraceDetailController = (): GetTraceDetailController =>
  new GetTraceDetailController({
    getTraceDetail: new GetTraceDetailDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
    }),
  });
