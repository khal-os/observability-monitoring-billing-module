import request from 'supertest';
import { server } from './app.js';

const app = server.app;

describe('App error shape', () => {
  it('MUST answer an unknown route as 404 JSON in the {name, msg} shape — never HTML', async () => {
    const response = await request(app)
      .get('/nao-existe')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      name: 'NotFoundError',
      msg: 'Not found: GET /nao-existe',
    });
  });

  it('MUST answer an unknown API path under /api/v1 in the same shape', async () => {
    const response = await request(app)
      .get('/api/v1/nao-existe')
      .expect(404)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      name: 'NotFoundError',
      msg: 'Not found: GET /api/v1/nao-existe',
    });
  });

  it('MUST answer a malformed JSON body as 400 JSON — no HTML, no stack trace', async () => {
    const response = await request(app)
      .post('/api/v1/traces')
      .set('Content-Type', 'application/json')
      .send('{"broken":')
      .expect(400)
      .expect('Content-Type', /json/);

    // Exact shape: nothing beyond {name, msg} — a stack would show here.
    expect(response.body).toEqual({
      name: 'InvalidParamError',
      msg: 'Invalid parameter: body',
    });
    expect(response.text).not.toMatch(/<html|<!DOCTYPE|SyntaxError/i);
  });

  it('MUST NOT advertise the framework via X-Powered-By', async () => {
    const response = await request(app).get('/nao-existe');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
