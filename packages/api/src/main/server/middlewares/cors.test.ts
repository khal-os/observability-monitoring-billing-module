import express from 'express';
import request from 'supertest';
import { corsMiddleware } from './index.js';

// Local app: the shared app now ends in a 404 catch-all, so routes
// registered after import would never be reached.
const app = express();
app.use(corsMiddleware);
app.get('/test-cors', (_, res) => {
  res.json({});
});

describe('CORS Middleware', () => {
  it('MUST allow CORS requests from any origin', async () => {
    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-origin', '*');
  });

  it('MUST allow CORS requests with allowed methods', async () => {
    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-methods', 'GET,POST');
  });

  it('MUST allow CORS requests with allowed headers', async () => {
    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-headers', 'Content-Type, Authorization');
  });
});
