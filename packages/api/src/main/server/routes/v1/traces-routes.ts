import { Router } from 'express';
import {
  makeGetTraceDetailController,
  makeListTraceFilterOptionsController,
  makeListTracesController,
} from '../../../factories/traces-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.get('/traces', adaptRoute(makeListTracesController()));
  // Before /traces/:id — Express matches in order; :id would swallow it.
  router.get(
    '/traces/filters',
    adaptRoute(makeListTraceFilterOptionsController()),
  );
  router.get('/traces/:id', adaptRoute(makeGetTraceDetailController()));
};
