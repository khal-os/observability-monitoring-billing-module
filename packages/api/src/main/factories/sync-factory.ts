import { SyncTracesToDbUseCase } from '../../application/useCases/syncTraces/sync-traces-use-case.js';
import { SyncBatchesToDbUseCase } from '../../application/useCases/syncBatches/sync-batches-use-case.js';
import { ReprocessPendingToDbUseCase } from '../../application/useCases/reprocessPending/reprocess-pending-use-case.js';
import { TraceSourceClient } from '../../application/interfaces/trace-source-client.js';
import { FakeTraceSourceClient } from '../../infrastructure/traceSource/fake-trace-source-client.js';
import { HttpLangWatchClient } from '../../infrastructure/traceSource/langwatch/http-langwatch-client.js';
import { ClickHouseLangWatchClient } from '../../infrastructure/traceSource/langwatch/clickhouse/clickhouse-langwatch-client.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { MongoDbTraceRepository } from '../../infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { MongoDbSyncStateRepository } from '../../infrastructure/database/mongodb/syncState/mongodb-sync-state-repository.js';
import { config } from '../../infrastructure/index.js';

const SYNC_DEFAULTS = {
  intervalSeconds: 60,
  batchSize: 1000,
  quietPeriodSeconds: 900, // decision 61: 15 min
  reprocessIntervalSeconds: 3600,
} as const;

// Decisão 59: com LANGWATCH_CLICKHOUSE_URL configurado, a fonte é o
// ClickHouse do próprio LangWatch (leitura direta, sem o teto de ~100 da
// busca HTTP). Nada fora deste factory sabe a diferença.
const makeClickHouseClient = (): ClickHouseLangWatchClient | undefined =>
  config.langwatchClickhouseUrl
    ? new ClickHouseLangWatchClient({
        url: config.langwatchClickhouseUrl,
        username: config.langwatchClickhouseUser ?? 'default',
        password: config.langwatchClickhousePassword ?? '',
        database: config.langwatchClickhouseDatabase ?? 'langwatch',
        tenantId: config.langwatchProjectId,
      })
    : undefined;

// QA14 resolvido: cadeia ClickHouse → HTTP → fake. O cliente HTTP entra
// quando LANGWATCH_ENDPOINT/API_KEY estão configurados; sem nada (testes,
// demo offline), o fake de fixtures continua valendo.
const makeTraceSourceClient = (): TraceSourceClient =>
  makeClickHouseClient() ??
  (config.langwatchEndpoint && config.langwatchApiKey
    ? new HttpLangWatchClient({
        endpoint: config.langwatchEndpoint,
        apiKey: config.langwatchApiKey,
      })
    : new FakeTraceSourceClient());

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

export const syncWorkerSettings = {
  intervalMs:
    (config.syncIntervalSeconds ?? SYNC_DEFAULTS.intervalSeconds) * 1000,
  reprocessIntervalMs:
    (config.reprocessIntervalSeconds ??
      SYNC_DEFAULTS.reprocessIntervalSeconds) * 1000,
} as const;

/**
 * Continuous sync exists ONLY with a ClickHouse source (decision 59): the
 * fixture fake and the capped HTTP search have no cursor to page on.
 * `undefined` → the worker idles (pre-onboarding / offline demo stacks,
 * where `make sync` over fixtures remains the path).
 */
export const makeSyncBatchesUseCase = ():
  | { useCase: SyncBatchesToDbUseCase; source: ClickHouseLangWatchClient }
  | undefined => {
  const source = makeClickHouseClient();

  if (!source) {
    return undefined;
  }

  return {
    source,
    useCase: new SyncBatchesToDbUseCase({
      traceBatchSource: source,
      syncStateRepository: new MongoDbSyncStateRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
      traceRepository: new MongoDbTraceRepository(),
      batchSize: config.syncBatchSize ?? SYNC_DEFAULTS.batchSize,
      quietPeriodMs:
        (config.syncQuietPeriodSeconds ?? SYNC_DEFAULTS.quietPeriodSeconds) *
        1000,
    }),
  };
};
