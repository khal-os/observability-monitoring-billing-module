import { ListTracesController } from '../../presentation/controllers/traces/list-traces-controller.js';
import { ListTraceFilterOptionsController } from '../../presentation/controllers/traces/list-trace-filter-options-controller.js';
import { GetTraceDetailController } from '../../presentation/controllers/traces/get-trace-detail-controller.js';
import { ListTracesDbUseCase } from '../../application/useCases/queryTraces/list-traces-db-use-case.js';
import { ListTraceFilterOptionsDbUseCase } from '../../application/useCases/queryTraces/list-trace-filter-options-db-use-case.js';
import { GetTraceDetailDbUseCase } from '../../application/useCases/queryTraces/get-trace-detail-db-use-case.js';
import { MongoDbTraceQueryRepository } from '@khal/core/infrastructure/database/mongodb/trace/mongodb-trace-query-repository.js';
import { config } from '../../infrastructure/index.js';
import { MongoDbPriceVersionRepository } from '@khal/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';

// The price repository feeds the READ-TIME derivation of
// pendingPrice.missingTokenTypes (see derive-pending-price.ts).
export const makeListTracesController = (): ListTracesController =>
  new ListTracesController({
    listTraces: new ListTracesDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
    }),
  });

// Module-level: the TTL cache (decision 77) must outlive single requests.
const listTraceFilterOptions = new ListTraceFilterOptionsDbUseCase({
  traceQueryRepository: new MongoDbTraceQueryRepository(),
  // Disabled under test so route suites assert cube ground truth directly.
  cacheTtlMs: config.Environment === 'test' ? 0 : 10_000,
});

export const makeListTraceFilterOptionsController =
  (): ListTraceFilterOptionsController =>
    new ListTraceFilterOptionsController({
      listTraceFilterOptions,
    });

export const makeGetTraceDetailController = (): GetTraceDetailController =>
  new GetTraceDetailController({
    getTraceDetail: new GetTraceDetailDbUseCase({
      traceQueryRepository: new MongoDbTraceQueryRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
    }),
  });
