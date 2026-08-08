import { Router } from 'express';
import {
  makeExportStatementController,
  makeGetBillingProjectionController,
  makeGetBillingSeriesController,
  makeGetBillingSummaryController,
  makeListBillsController,
} from '../../../factories/billing-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

/**
 * Billing read layer (T7/T8/US17) — all GET: the lifecycle (close/reopen)
 * exists only as runbook jobs in v1 (decision 87), never as HTTP.
 */
export default (router: Router): void => {
  router.get('/bills', adaptRoute(makeListBillsController()));
  router.get('/billing/summary', adaptRoute(makeGetBillingSummaryController()));
  router.get('/billing/series', adaptRoute(makeGetBillingSeriesController()));
  router.get(
    '/billing/projection',
    adaptRoute(makeGetBillingProjectionController()),
  );
  // One statement resource; the representation is ?format=csv|html
  // (decision 98 — RESTful, no per-format routes).
  router.get('/billing/statement', adaptRoute(makeExportStatementController()));
};
