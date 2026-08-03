import express from 'express';
import request from 'supertest';
import { bodyParserMiddleware } from './index.js';

// Local app: the shared app now ends in a 404 catch-all, so routes
// registered after import would never be reached.
const app = express();
app.use(bodyParserMiddleware);
app.post('/test-body-parser', (req, res) => {
  res.json(req.body);
});

describe('Body Parser Middleware', () => {
  it('SHOULD parse JSON body correctly', async () => {
    await request(app)
      .post('/test-body-parser')
      .send({ name: 'John Doe', age: 30 })
      .expect({ name: 'John Doe', age: 30 });
  });
});
