import express from 'express';
import request from 'supertest';
import { corsMiddleware } from './index.js';

/**
 * Same-origin by design (audit D-1). The OLD suite pinned the wildcard —
 * "MUST allow CORS requests from any origin" — which made an exfiltration
 * vector look intentional: with auth off (PoC default), `ACAO: *` let any
 * web page a LAN operator visited read the unmasked archive through the
 * operator's own browser. These tests pin the inverse.
 */
const app = express();
app.use(corsMiddleware);
app.get('/test-cors', (_req, res) => {
  res.json({});
});

describe('CORS Middleware', () => {
  it('MUST NOT emit any allow-origin header when CORS_ALLOWED_ORIGINS is unset — same-origin only', async () => {
    const response = await request(app)
      .get('/test-cors')
      .set('Origin', 'https://evil.example');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('MUST NOT echo an arbitrary Origin back', async () => {
    const response = await request(app)
      .get('/test-cors')
      .set('Origin', 'http://attacker.internal:8080');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
