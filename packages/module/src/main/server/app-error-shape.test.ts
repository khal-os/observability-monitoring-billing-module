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

  it('MUST answer an oversized JSON body as 413 — the original status, not a flattened 400 (C-5.1)', async () => {
    const response = await request(app)
      .post('/api/v1/prices')
      .set('Content-Type', 'application/json')
      .send(`{"model":"${'x'.repeat(120 * 1024)}"}`)
      .expect(413)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      name: 'PayloadTooLargeError',
      msg: 'Payload too large',
    });
  });

  describe('405 for a known path with the wrong method (C-5.2)', () => {
    it('MUST answer DELETE /api/v1/prices as 405 with Allow: POST', async () => {
      const response = await request(app)
        .delete('/api/v1/prices')
        .expect(405)
        .expect('Content-Type', /json/);

      expect(response.headers.allow).toBe('POST');
      expect(response.body).toEqual({
        name: 'MethodNotAllowedError',
        msg: 'Method not allowed: DELETE /api/v1/prices',
      });
    });

    it('MUST answer POST /api/v1/traces as 405 with Allow: GET, HEAD', async () => {
      const response = await request(app).post('/api/v1/traces').expect(405);

      // HEAD is derived by Express from the GET route and IS served —
      // omitting it told a client the resource has no HEAD (re-audit
      // iteration 2).
      expect(response.headers.allow).toBe('GET, HEAD');
      expect(response.body).toEqual({
        name: 'MethodNotAllowedError',
        msg: 'Method not allowed: POST /api/v1/traces',
      });
    });

    it('MUST report the SAME method set as OPTIONS on the same path — one resource, one answer', async () => {
      const methodSet = (allow: string | undefined): string[] =>
        (allow ?? '')
          .split(',')
          .map((method) => method.trim())
          .filter((method) => method.length > 0)
          .sort();

      const notAllowed = await request(app).delete('/api/v1/traces').expect(405);
      const options = await request(app).options('/api/v1/traces').expect(200);

      expect(methodSet(notAllowed.headers.allow)).toEqual(['GET', 'HEAD']);
      expect(methodSet(notAllowed.headers.allow)).toEqual(
        methodSet(options.headers.allow),
      );
    });

    it('MUST NOT answer 405 to the HEAD it advertises — the method genuinely reaches the route', async () => {
      const response = await request(app).head('/api/v1/traces');

      // Whatever the controller answers without a DB behind it, the one
      // thing HEAD must never be is "method not allowed" while the Allow
      // header lists it.
      expect(response.status).not.toBe(405);
    });

    it('MUST keep answering an unknown path as plain 404 (GET /api/v1/nope)', async () => {
      const response = await request(app).get('/api/v1/nope').expect(404);

      expect(response.body).toEqual({
        name: 'NotFoundError',
        msg: 'Not found: GET /api/v1/nope',
      });
    });

    it('MUST match the table case-insensitively, like Express routing (POST /API/V1/TRACES)', async () => {
      const response = await request(app)
        .post('/API/V1/TRACES')
        .expect(405)
        .expect('Content-Type', /json/);

      expect(response.headers.allow).toBe('GET, HEAD');
      expect(response.body).toEqual({
        name: 'MethodNotAllowedError',
        msg: 'Method not allowed: POST /API/V1/TRACES',
      });
    });
  });

  it('MUST answer OPTIONS on a known path with Allow and WITHOUT the JSON default content-type', async () => {
    const response = await request(app).options('/api/v1/traces').expect(200);

    // Express's default OPTIONS handler: a plain-text method list. The
    // default-content-type middleware must not stamp it application/json.
    expect(response.headers.allow).toContain('GET');
    expect(response.headers['content-type']).not.toContain('application/json');
  });
});
