import { SyncTracesToDbUseCase } from '../../application/useCases/syncTraces/sync-traces-use-case.js';
import { ReprocessPendingToDbUseCase } from '../../application/useCases/reprocessPending/reprocess-pending-use-case.js';
import { TraceSourceClient } from '../../application/interfaces/trace-source-client.js';
import { FakeTraceSourceClient } from '../../infrastructure/traceSource/fake-trace-source-client.js';
import { HttpLangWatchClient } from '../../infrastructure/traceSource/langwatch/http-langwatch-client.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { MongoDbTraceRepository } from '../../infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { config } from '../../infrastructure/index.js';

// QA14 resolvido: o cliente REAL entra quando LANGWATCH_ENDPOINT/API_KEY
// estão configurados no ambiente; sem eles (testes, demo offline), o fake
// de fixtures continua valendo. Nada fora deste factory sabe a diferença.
const makeTraceSourceClient = (): TraceSourceClient =>
  config.langwatchEndpoint && config.langwatchApiKey
    ? new HttpLangWatchClient({
        endpoint: config.langwatchEndpoint,
        apiKey: config.langwatchApiKey,
      })
    : new FakeTraceSourceClient();

export const makeSyncTracesUseCase = (): SyncTracesToDbUseCase =>
  new SyncTracesToDbUseCase({
    traceSourceClient: makeTraceSourceClient(),
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
  });

export const makeReprocessPendingUseCase = (): ReprocessPendingToDbUseCase =>
  new ReprocessPendingToDbUseCase({
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
  });
