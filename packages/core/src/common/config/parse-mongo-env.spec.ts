import {
  mongoEnvSchemaShape,
  toMongoDbEnvironment,
} from './parse-mongo-env.js';
import { z } from 'zod';

/**
 * audit C-6: core owns the Mongo env TYPE, so it owns the READER — both
 * images now spread this one parser. This suite is that reader's one home.
 */
describe('shared Mongo env parser (audit C-6)', () => {
  const schema = z.object(mongoEnvSchemaShape);

  it('MUST accept and transform a full Atlas configuration', () => {
    const parsed = schema.parse({
      MONGO_DB_ATLAS: 'true',
      MONGO_DB_HOST: 'cluster0.example.mongodb.net',
      MONGO_DB_NAME: 'observability',
      MONGO_DB_USER: 'platform',
      MONGO_DB_PASSWORD: 's3cret',
      MONGO_DB_PORT: '27017',
    });

    expect(toMongoDbEnvironment(parsed)).toEqual({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'observability',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
      mongoDbPort: 27017,
    });
  });

  it('MUST leave optional fields undefined and map the boolean/int strings', () => {
    expect(toMongoDbEnvironment(schema.parse({}))).toEqual({
      mongoDbAtlas: undefined,
      mongoDbHost: undefined,
      mongoDbName: undefined,
      mongoDbUser: undefined,
      mongoDbPassword: undefined,
      mongoDbPort: undefined,
    });
    expect(toMongoDbEnvironment(schema.parse({ MONGO_DB_ATLAS: 'false' })).mongoDbAtlas).toBe(false);
  });

  it('MUST refuse a non-integer port and an invalid atlas flag', () => {
    expect(schema.safeParse({ MONGO_DB_PORT: 'abc' }).success).toBe(false);
    expect(schema.safeParse({ MONGO_DB_ATLAS: 'yes' }).success).toBe(false);
  });
});
