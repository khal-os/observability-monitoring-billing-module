import { GetBillingSummaryController } from '../../presentation/controllers/billing/get-billing-summary-controller.js';
import { ListBillsController } from '../../presentation/controllers/billing/list-bills-controller.js';
import { GetBillingSeriesController } from '../../presentation/controllers/billing/get-billing-series-controller.js';
import { GetBillingProjectionController } from '../../presentation/controllers/billing/get-billing-projection-controller.js';
import { ExportStatementController } from '../../presentation/controllers/billing/export-statement-controller.js';
import { GetBillingSummaryDbUseCase } from '../../application/useCases/billingSummary/get-billing-summary-db-use-case.js';
import { ListBillsDbUseCase } from '../../application/useCases/billingSummary/list-bills-db-use-case.js';
import { GetBillingSeriesDbUseCase } from '../../application/useCases/billingSeries/get-billing-series-db-use-case.js';
import { GetBillingProjectionDbUseCase } from '../../application/useCases/billingSeries/get-billing-projection-db-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../../application/useCases/billingLifecycle/close-billing-period-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from '../../application/useCases/billingLifecycle/reopen-billing-period-db-use-case.js';
import { MongoDbBillingQueryRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.js';
import { MongoDbBillingPeriodRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import { MongoDbBillingSnapshotRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-snapshot-repository.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';

const makeGetBillingSummaryUseCase = (): GetBillingSummaryDbUseCase =>
  new GetBillingSummaryDbUseCase({
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
  });

export const makeGetBillingSummaryController = (): GetBillingSummaryController =>
  new GetBillingSummaryController({
    getBillingSummary: makeGetBillingSummaryUseCase(),
  });

export const makeListBillsController = (): ListBillsController =>
  new ListBillsController({
    listBills: new ListBillsDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
    }),
  });

export const makeGetBillingSeriesController = (): GetBillingSeriesController =>
  new GetBillingSeriesController({
    getBillingSeries: new GetBillingSeriesDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
      billingPeriodRepository: new MongoDbBillingPeriodRepository(),
      billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
    }),
  });

export const makeGetBillingProjectionController = (): GetBillingProjectionController =>
  new GetBillingProjectionController({
    getBillingProjection: new GetBillingProjectionDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
    }),
  });

export const makeExportStatementController = (): ExportStatementController =>
  new ExportStatementController({
    getBillingSummary: makeGetBillingSummaryUseCase(),
  });

/** Runbook jobs (decision 87): the lifecycle exists ONLY as jobs in v1. */
export const makeCloseBillingPeriodUseCase = (): CloseBillingPeriodDbUseCase =>
  new CloseBillingPeriodDbUseCase({
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
    // Post-close quarantine reconciliation (audit B-1, decision 100).
    traceRepository: new MongoDbTraceRepository(),
  });

export const makeReopenBillingPeriodUseCase = (): ReopenBillingPeriodDbUseCase =>
  new ReopenBillingPeriodDbUseCase({
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
  });
