import { Application, Router } from 'express';
import tracesRoutes from '../routes/v1/traces-routes.js';
import sessionsRoutes from '../routes/v1/sessions-routes.js';
import billingRoutes from '../routes/v1/billing-routes.js';
import pricesRoutes from '../routes/v1/prices-routes.js';
import { RegisteredRoute } from '../middlewares/not-found.js';

/**
 * Routes are registered statically: the previous fast-glob discovery
 * matched only .ts sources under src/ relative to cwd, so the compiled
 * build (`node dist/main/index.js`) crashed at startup and any other cwd
 * served 404s. A new route module is one import + one line here.
 */
const registerRoutes = [
  tracesRoutes,
  sessionsRoutes,
  billingRoutes,
  pricesRoutes,
];

export const API_V1_PREFIX = '/api/v1';

/**
 * Returns the served route table DERIVED from the router itself (audit
 * D-4): the 405 handler's table used to be a hand-maintained duplicate —
 * "one line there, and one line here" — which is the repo's own named
 * root-cause pattern (one rule, two spellings) at the API's front door.
 * A forgotten line made a served route answer 405 "not allowed" while the
 * router served it, and RFC 7231 lets clients CACHE an Allow list.
 * Deriving removes the second spelling instead of correcting it.
 */
export const setupV1Routes = (app: Application): RegisteredRoute[] => {
  const apiV1Router = Router();

  for (const register of registerRoutes) {
    register(apiV1Router);
  }

  app.use(API_V1_PREFIX, apiV1Router);

  const routes: RegisteredRoute[] = [];

  for (const layer of (
    apiV1Router as unknown as {
      stack: {
        route?: { path: string; methods: Record<string, boolean> };
      }[];
    }
  ).stack) {
    if (!layer.route) continue;

    for (const method of Object.keys(layer.route.methods)) {
      routes.push({
        method: method.toUpperCase(),
        path: `${API_V1_PREFIX}${layer.route.path}`,
      });
    }
  }

  return routes;
};
