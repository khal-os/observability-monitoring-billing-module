import { Router } from 'express';
import { makeRegisterPriceVersionController } from '../../../factories/price-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.post('/prices', adaptRoute(makeRegisterPriceVersionController()));
};
