import { Request, Response } from 'express';
import {
  Controller,
  HttpRequest,
  HttpResponse,
} from '../../presentation/interfaces/index.js';
import { buildServerError } from '../../presentation/helpers/http-helper.js';
import { ServerError } from '../../presentation/errors/index.js';
import { makeLogger } from '../factories/logger-factory.js';

// main-layer wiring: the adapter is instantiated once per route at
// composition time, so it takes the root logger directly (same pattern as
// the factories reading config).
const logger = makeLogger({ component: 'http' });

export const adaptRoute = (controller: Controller) => {
  return async (req: Request, res: Response): Promise<void> => {
    const httpRequest: HttpRequest = {
      body: req.body,
      params: req.params,
      query: req.query,
    };

    try {
      const httpResponse: HttpResponse = await controller.handle(httpRequest);

      if (httpResponse.headers) {
        res.set(httpResponse.headers);
      }

      if (httpResponse.raw) {
        res.status(httpResponse.statusCode).send(httpResponse.body);
        return;
      }

      res.status(httpResponse.statusCode).json(httpResponse.body);
    } catch (error) {
      logger.error('Route handler error', { err: error });

      const httpResponse = buildServerError(new ServerError());

      res.status(httpResponse.statusCode).json(httpResponse.body);
    }
  };
};
