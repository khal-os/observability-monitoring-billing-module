import request from 'supertest';
import { server } from '../app.js';

const app = server.app;

describe('Content-Type Middleware', () => {
  it('SHOULD set the correct Content-Type header', async () => {
    app.get('/test-content-type', (_, res) => {
      res.send('');
    });

    await request(app).get('/test-content-type').expect('Content-Type', /json/);
  });

  it('SHOULD set the xml Content-Type header when requested', async () => {
    app.get('/test-content-type-xml', (_, res) => {
      res.type('application/xml');
      res.send('');
    });

    await request(app).get('/test-content-type-xml').expect('content-type', /xml/);
  });
});
