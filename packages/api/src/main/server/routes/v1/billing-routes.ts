import { Router } from 'express';
import {
  makeGetBillingSummaryController,
  makeListBillsController,
} from '../../../factories/billing-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.get('/bills', adaptRoute(makeListBillsController()));
  router.get('/billing/summary', adaptRoute(makeGetBillingSummaryController()));
};
