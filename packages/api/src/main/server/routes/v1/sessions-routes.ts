import { Router } from 'express';
import {
  makeGetSessionDetailController,
  makeListSessionsController,
} from '../../../factories/sessions-factory.js';
import { adaptRoute } from '../../../adapters/express-route-adapter.js';

export default (router: Router): void => {
  router.get('/sessions', adaptRoute(makeListSessionsController()));
  router.get('/sessions/:id', adaptRoute(makeGetSessionDetailController()));
};
