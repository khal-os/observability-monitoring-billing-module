import { Application } from 'express';
import {
  errorHandlerMiddleware,
  notFoundMiddleware,
} from '../middlewares/index.js';

/**
 * MUST be the last setup call: the 404 catch-all only fires for paths no
 * route claimed, and Express hands middleware errors to the LAST error
 * handler registered — both depend on coming after the routes.
 */
export const setupErrorHandling = (app: Application): void => {
  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware);
};
