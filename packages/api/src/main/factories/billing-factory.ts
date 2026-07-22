import { GetBillingSummaryController } from '../../presentation/controllers/billing/get-billing-summary-controller.js';
import { ListBillsController } from '../../presentation/controllers/billing/list-bills-controller.js';
import { GetBillingSummaryDbUseCase } from '../../application/useCases/billingSummary/get-billing-summary-db-use-case.js';
import { ListBillsDbUseCase } from '../../application/useCases/billingSummary/list-bills-db-use-case.js';
import { MongoDbBillingQueryRepository } from '../../infrastructure/database/mongodb/billing/mongodb-billing-query-repository.js';

export const makeGetBillingSummaryController = (): GetBillingSummaryController =>
  new GetBillingSummaryController({
    getBillingSummary: new GetBillingSummaryDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
    }),
  });

export const makeListBillsController = (): ListBillsController =>
  new ListBillsController({
    listBills: new ListBillsDbUseCase({
      billingQueryRepository: new MongoDbBillingQueryRepository(),
    }),
  });
