import { ReprocessPendingDbUseCase } from '@khal/core/application/useCases/reprocessPending/reprocess-pending-db-use-case.js';
import { MongoDbPriceVersionRepository } from '@khal/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { MongoDbTraceRepository } from '@khal/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { MongoDbBillingPeriodRepository } from '@khal/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';

/**
 * The module's OWN wiring of the reprocess sweep (decisions 82/57/83):
 * price registration triggers an immediate reprocess, so the use case must
 * be composable without the connector — the worker loop wires its own copy
 * in the connector's sync-factory. Same core use case, two composition
 * roots, one calculation (invariant 3).
 */
export const makeReprocessPendingUseCase = (): ReprocessPendingDbUseCase =>
  new ReprocessPendingDbUseCase({
    priceVersionRepository: new MongoDbPriceVersionRepository(),
    traceRepository: new MongoDbTraceRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
  });
