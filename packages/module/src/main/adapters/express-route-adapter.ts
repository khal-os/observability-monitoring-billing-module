import { Request, Response } from 'express';
import { Controller, HttpRequest, HttpResponse } from "../../presentation/interfaces/index.js";
import { buildServerError } from '../../presentation/helpers/http-helper.js';
import { ServerError } from '../../presentation/errors/index.js';

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
      console.error('Route handler error:', error);

      const httpResponse = buildServerError(new ServerError());

      res.status(httpResponse.statusCode).json(httpResponse.body);
    }
  };
};
