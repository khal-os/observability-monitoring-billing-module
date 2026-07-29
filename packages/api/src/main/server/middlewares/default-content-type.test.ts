import express from 'express';
import request from 'supertest';
import { defaultContentTypeMiddleware } from './index.js';

// Local app: the shared app now ends in a 404 catch-all, so routes
// registered after import would never be reached.
const app = express();
app.use(defaultContentTypeMiddleware);
app.get('/test-content-type', (_, res) => {
  res.send('');
});
app.get('/test-content-type-xml', (_, res) => {
  res.type('application/xml');
  res.send('');
});

describe('Content-Type Middleware', () => {
  it('SHOULD set the correct Content-Type header', async () => {
    await request(app).get('/test-content-type').expect('Content-Type', /json/);
  });

  it('SHOULD set the xml Content-Type header when requested', async () => {
    await request(app).get('/test-content-type-xml').expect('content-type', /xml/);
  });
});
