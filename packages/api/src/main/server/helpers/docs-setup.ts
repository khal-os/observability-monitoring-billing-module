import { Application, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../../docs/openapi.js';
import { config } from '../../../infrastructure/index.js';

export const setupDocs = (app: Application): void => {
  const document = buildOpenApiDocument(config.clientName);

  app.get('/api/v1/docs/openapi.json', (request: Request, response: Response) => {
    response.json(document);
  });

  app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(document));
};
