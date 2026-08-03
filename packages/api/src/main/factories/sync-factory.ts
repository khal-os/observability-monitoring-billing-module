import { SyncTracesDbUseCase } from '../../application/useCases/syncTraces/sync-traces-db-use-case.js';
import { SyncBatchesDbUseCase } from '../../application/useCases/syncBatches/sync-batches-db-use-case.js';
import { ReprocessPendingDbUseCase } from '../../application/useCases/reprocessPending/reprocess-pending-db-use-case.js';
import { TraceSourceClient } from '../../application/interfaces/trace-source-client.js';
import { FakeTraceSourceClient } from '../../infrastructure/traceSource/fake-trace-source-client.js';
import { HttpLangWatchClient } from '../../infrastructure/traceSource/langwatch/http-langwatch-client.js';
import { ClickHouseLangWatchClient } from '../../infrastructure/traceSource/langwatch/clickhouse/clickhouse-langwatch-client.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { MongoDbTraceRepository } from '../../infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { MongoDbSyncStateRepository } from '../../infrastructure/database/mongodb/syncState/mongodb-sync-state-repository.js';
import { MongoDbBillingPeriodRepository } from '../../infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { MongoDbIngestFailureRepository } from '../../infrastructure/database/mongodb/ingestFailures/mongodb-ingest-failure-repository.js';
import { MongoDbPoisonRowRepository } from '../../infrastructure/database/mongodb/ingestFailures/mongodb-poison-row-repository.js';
import { estimateBsonBytes } from '../../infrastructure/database/mongodb/ingestFailures/bson-size-estimator.js';
import { config } from '../../infrastructure/index.js';

const INGESTION_DEFAULTS = {
  intervalSeconds: 60,
  batchSize: 1000,
  quietPeriodSeconds: 900, // decision 61: 15 min
  reprocessIntervalSeconds: 3600,
} as const;

// Decisão 59: com LANGWATCH_CLICKHOUSE_URL configurado, a fonte é o
// ClickHouse do próprio LangWatch (leitura direta, sem o teto de ~100 da
// busca HTTP). Nada fora deste factory sabe a diferença.
const quietPeriodMs = (): number =>
  (config.traceIngestionQuietPeriodSeconds ??
    INGESTION_DEFAULTS.quietPeriodSeconds) * 1000;

const makeClickHouseClient = (): ClickHouseLangWatchClient | undefined =>
  config.langwatchClickhouseUrl
    ? new ClickHouseLangWatchClient({
        url: config.langwatchClickhouseUrl,
        username: config.langwatchClickhouseUser ?? 'default',
        password: config.langwatchClickhousePassword ?? '',
        database: config.langwatchClickhouseDatabase ?? 'langwatch',
        tenantId: config.langwatchProjectId,
        quietPeriodMs: quietPeriodMs(),
        // audit C-6.2: skipped rows leave a durable record, not just a log.
        poisonRowRepository: new MongoDbPoisonRowRepository(),
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
        quietPeriodMs: quietPeriodMs(),
        // audit C-6.2: same durable poison trail as the ClickHouse path.
        poisonRowRepository: new MongoDbPoisonRowRepository(),
      })
    : new FakeTraceSourceClient());

export const makeSyncTracesUseCase = (): SyncTracesDbUseCase =>
  new SyncTracesDbUseCase({
    traceSourceClient: makeTraceSourceClient(),
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    // audit B-3: dead-letter trail + pre-insert size guard.
    ingestFailureRepository: new MongoDbIngestFailureRepository(),
    estimateDocumentBytes: estimateBsonBytes,
  });

export const makeReprocessPendingUseCase = (): ReprocessPendingDbUseCase =>
  new ReprocessPendingDbUseCase({
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
  });

export const traceIngestionWorkerSettings = {
  intervalMs:
    (config.traceIngestionIntervalSeconds ?? INGESTION_DEFAULTS.intervalSeconds) * 1000,
  reprocessIntervalMs:
    (config.reprocessIntervalSeconds ??
      INGESTION_DEFAULTS.reprocessIntervalSeconds) * 1000,
} as const;

/**
 * Continuous sync exists ONLY with a ClickHouse source (decision 59): the
 * fixture fake and the capped HTTP search have no cursor to page on.
 * `undefined` → the worker idles (pre-onboarding / offline demo stacks,
 * where `make sync` over fixtures remains the path).
 */
export const makeSyncBatchesUseCase = ():
  | { useCase: SyncBatchesDbUseCase; source: ClickHouseLangWatchClient }
  | undefined => {
  const source = makeClickHouseClient();

  if (!source) {
    return undefined;
  }

  return {
    source,
    useCase: new SyncBatchesDbUseCase({
      traceBatchSource: source,
      syncStateRepository: new MongoDbSyncStateRepository(),
      priceVersionRepository: new MongoDbPriceVersionRepository(),
      traceRepository: new MongoDbTraceRepository(),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      // audit B-3: dead-letter trail + pre-insert size guard.
      ingestFailureRepository: new MongoDbIngestFailureRepository(),
      estimateDocumentBytes: estimateBsonBytes,
      batchSize: config.traceIngestionBatchSize ?? INGESTION_DEFAULTS.batchSize,
      quietPeriodMs: quietPeriodMs(),
    }),
  };
};
