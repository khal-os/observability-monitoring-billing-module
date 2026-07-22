import { Application } from 'express';
import {
  urlEncodedMiddleware,
  bodyParserMiddleware,
  corsMiddleware,
  defaultContentTypeMiddleware,
  requestLoggerMiddleware,
} from '../middlewares/index.js';

export const setupMiddlewares = (app: Application): void => {
  app.use(requestLoggerMiddleware);
  app.use(urlEncodedMiddleware);
  app.use(bodyParserMiddleware);
  app.use(corsMiddleware);
  app.use(defaultContentTypeMiddleware);
};
