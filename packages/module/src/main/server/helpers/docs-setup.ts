import { Application, NextFunction, Request, Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from '../../docs/openapi.js';
import { config } from '../../../infrastructure/index.js';

export const setupDocs = (app: Application): void => {
  const document = buildOpenApiDocument(config.clientName);

  app.get('/api/v1/docs/openapi.json', (request: Request, response: Response) => {
    response.json(document);
  });

  // Without the trailing slash the UI's relative assets resolve OUTSIDE
  // the mount (/api/v1/swagger-ui.css → 404) and the page renders broken
  // — answer a permanent redirect to the canonical slash form (C-5.3).
  app.get(
    '/api/v1/docs',
    (request: Request, response: Response, next: NextFunction) => {
      // Express matches '/api/v1/docs/' against this route too (non-strict
      // routing) — only the slashless spelling redirects.
      if (request.path.endsWith('/')) {
        next();
        return;
      }
      response.redirect(301, '/api/v1/docs/');
    },
  );

  // serve = the UI's static assets; setup pinned to the EXACT index path,
  // so /api/v1/docs/<garbage> falls through to the JSON 404 instead of
  // answering 200 with the docs page (C-5.3).
  app.use('/api/v1/docs', swaggerUi.serve);
  app.get('/api/v1/docs/', swaggerUi.setup(document));
};
