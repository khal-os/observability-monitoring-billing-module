import express from 'express';
import request from 'supertest';
import { setupDocs, setupErrorHandling, setupV1Routes } from './helpers/index.js';
import { buildAuthMiddleware } from './middlewares/index.js';
import { TokenAuthenticator } from '../../application/interfaces/token-authenticator.js';

/**
 * Mirrors app.ts's LOAD-BEARING ordering with a real (stubbed-authenticator)
 * auth middleware injected: docs are mounted BEFORE auth on purpose — they
 * are the healthcheck and stay open (decision Q5); everything under /api/v1
 * behind them answers 401. If someone reorders app.ts, this is the test
 * that says which behavior was the contract.
 */
const rejectEverything: TokenAuthenticator = {
  isAuthenticated: async () => false,
};

const makeAppWithAuth = () => {
  const app = express();
  // Same sequence as app.ts: docs first, then auth, then the API routes,
  // then the 404/error boundary.
  setupDocs(app);
  app.use(buildAuthMiddleware(rejectEverything));
  const routes = setupV1Routes(app);
  setupErrorHandling(app, routes);
  return app;
};

describe('App auth gating (env-gated M2M bearer)', () => {
  it('MUST answer /api/v1/traces 401 while /api/v1/docs/ and openapi.json stay open', async () => {
    const app = makeAppWithAuth();

    const traces = await request(app).get('/api/v1/traces').expect(401);
    expect(traces.body).toEqual({
      name: 'UnauthorizedError',
      msg: 'Unauthorized',
    });

    const docs = await request(app).get('/api/v1/docs/').expect(200);
    expect(docs.headers['content-type']).toContain('text/html');

    const openapi = await request(app)
      .get('/api/v1/docs/openapi.json')
      .expect(200);
    expect(openapi.body.openapi).toBe('3.1.0');
  });

  it('MUST gate every API face, not just traces', async () => {
    const app = makeAppWithAuth();

    for (const path of [
      '/api/v1/sessions',
      '/api/v1/bills',
      '/api/v1/billing/summary?year=2026&month=6',
    ]) {
      await request(app).get(path).expect(401);
    }

    await request(app).post('/api/v1/prices').expect(401);
  });
});
