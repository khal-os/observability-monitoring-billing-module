import request from 'supertest';
import { server } from '../app.js';

const app = server.app;

describe('CORS Middleware', () => {
  it('MUST allow CORS requests from any origin', async () => {
    app.get('/test-cors', (_, res) => {
      res.json();
    });

    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-origin', '*');
  });

  it('MUST allow CORS requests with allowed methods', async () => {
    app.get('/test-cors', (_, res) => {
      res.json({});
    });

    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-methods', 'GET,POST');
  });

  it('MUST allow CORS requests with allowed headers', async () => {
    app.get('/test-cors', (_, res) => {
      res.json({});
    });

    await request(app)
      .get('/test-cors')
      .expect('access-control-allow-headers', 'Content-Type, Authorization');
  });
});
