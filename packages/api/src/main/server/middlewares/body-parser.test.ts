import request from 'supertest';
import { server } from '../app.js';

const app = server.app;

describe('Body Parser Middleware', () => {
  it('SHOULD parse JSON body correctly', async () => {
    app.post('/test-body-parser', (req, res) => {
      res.json(req.body);
    });

    await request(app)
      .post('/test-body-parser')
      .send({ name: 'John Doe', age: 30 })
      .expect({ name: 'John Doe', age: 30 });
  });
});
