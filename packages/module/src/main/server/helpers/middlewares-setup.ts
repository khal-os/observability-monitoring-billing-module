import { Application } from 'express';
import {
  bodyParserMiddleware,
  corsMiddleware,
  cacheHeadersMiddleware,
  requireJsonMiddleware,
  defaultContentTypeMiddleware,
  requestLoggerMiddleware,
} from '../middlewares/index.js';
import { makeAuthMiddleware } from '../../factories/auth-factory.js';

export const setupMiddlewares = (app: Application): void => {
  // Fingerprinting header — no reason to advertise the framework.
  app.disable('x-powered-by');
  app.use(requestLoggerMiddleware);
  // JSON only ON PURPOSE: no urlencoded parser — this is a JSON API and a
  // form-encoded body must never be silently accepted (C-1). The 415 gate
  // runs FIRST (audit D-2): body-parser turns a non-JSON body into {} and
  // the controllers then misdiagnose it as missing fields.
  app.use(requireJsonMiddleware);
  app.use(bodyParserMiddleware);
  app.use(corsMiddleware);
  // After CORS (preflights must answer), before routes. Docs are mounted
  // BEFORE middlewares in app.ts and stay open — they are the healthcheck.
  app.use(makeAuthMiddleware());
  app.use(defaultContentTypeMiddleware);
  // audit D-7: no-store + nosniff defaults; controllers override for the
  // provably-cacheable (closed months).
  app.use(cacheHeadersMiddleware);
};
