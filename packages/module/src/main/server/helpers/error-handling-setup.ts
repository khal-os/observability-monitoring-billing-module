import { Application } from 'express';
import { Logger } from '@observability/core/common/logging/logger.js';
import {
  makeErrorHandlerMiddleware,
  makeNotFoundMiddleware,
} from '../middlewares/index.js';
import { RegisteredRoute } from '../middlewares/not-found.js';

/**
 * MUST be the last setup call: the 404 catch-all only fires for paths no
 * route claimed, and Express hands middleware errors to the LAST error
 * handler registered — both depend on coming after the routes. The route
 * table arrives DERIVED from the router (audit D-4) — never a second,
 * hand-maintained spelling.
 */
export const setupErrorHandling = (
  app: Application,
  routes: RegisteredRoute[],
  logger: Logger,
): void => {
  app.use(makeNotFoundMiddleware(routes));
  app.use(makeErrorHandlerMiddleware(logger));
};
