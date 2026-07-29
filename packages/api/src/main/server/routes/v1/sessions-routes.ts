import { Router } from 'express';
import {
  makeGetSessionDetailController,
  makeListSessionFilterOptionsController,
  makeListSessionsController,
} from '../../../factories/sessions-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.get('/sessions', adaptRoute(makeListSessionsController()));
  // Before /sessions/:id — otherwise "filters" is captured as an id.
  router.get(
    '/sessions/filters',
    adaptRoute(makeListSessionFilterOptionsController()),
  );
  router.get('/sessions/:id', adaptRoute(makeGetSessionDetailController()));
};
