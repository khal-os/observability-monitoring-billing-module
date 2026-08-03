import { Application } from 'express';
import {
  bodyParserMiddleware,
  corsMiddleware,
  defaultContentTypeMiddleware,
  requestLoggerMiddleware,
} from '../middlewares/index.js';
import { makeAuthMiddleware } from '../../factories/auth-factory.js';

export const setupMiddlewares = (app: Application): void => {
  // Fingerprinting header — no reason to advertise the framework.
  app.disable('x-powered-by');
  app.use(requestLoggerMiddleware);
  // JSON only ON PURPOSE: no urlencoded parser — this is a JSON API and a
  // form-encoded body must never be silently accepted (C-1).
  app.use(bodyParserMiddleware);
  app.use(corsMiddleware);
  // After CORS (preflights must answer), before routes. Docs are mounted
  // BEFORE middlewares in app.ts and stay open — they are the healthcheck.
  app.use(makeAuthMiddleware());
  app.use(defaultContentTypeMiddleware);
};
