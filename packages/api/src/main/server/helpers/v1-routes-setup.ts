import { Application, Router } from 'express';
import tracesRoutes from '../routes/v1/traces-routes.js';
import sessionsRoutes from '../routes/v1/sessions-routes.js';
import billingRoutes from '../routes/v1/billing-routes.js';

/**
 * Routes are registered statically: the previous fast-glob discovery
 * matched only .ts sources under src/ relative to cwd, so the compiled
 * build (`node dist/main/index.js`) crashed at startup and any other cwd
 * served 404s. A new route module is one import + one line here.
 */
const registerRoutes = [tracesRoutes, sessionsRoutes, billingRoutes];

export const setupV1Routes = (app: Application): void => {
  const apiV1Router = Router();

  for (const register of registerRoutes) {
    register(apiV1Router);
  }

  app.use('/api/v1', apiV1Router);
};
