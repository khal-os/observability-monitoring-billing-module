import { Router } from 'express';
import {
  makeListPriceVersionsController,
  makeRegisterPriceVersionController,
} from '../../../factories/price-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  // US4 / audit D-3: the price table is READABLE — registering is not the
  // only door, and the pending_price diagnostic needs to SEE the rows.
  router.get('/prices', adaptRoute(makeListPriceVersionsController()));
  router.post('/prices', adaptRoute(makeRegisterPriceVersionController()));
};
