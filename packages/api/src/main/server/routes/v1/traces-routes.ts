import { Router } from 'express';
import {
  makeGetTraceDetailController,
  makeListTracesController,
} from '../../../factories/traces-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.get('/traces', adaptRoute(makeListTracesController()));
  router.get('/traces/:id', adaptRoute(makeGetTraceDetailController()));
};
