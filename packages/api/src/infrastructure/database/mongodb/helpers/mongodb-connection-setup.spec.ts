import { buildMongoDbUri } from './mongodb-connection-setup.js';

describe('buildMongoDbUri()', () => {
  it('MUST build a plain local URI when no credentials are provided', () => {
    const { uri, message } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
    });

    expect(uri).toBe('mongodb://mongo:27017/cleandb');
    expect(message).toContain('"cleandb"');
  });

  it('MUST embed credentials with authSource=admin when user and password are provided', () => {
    const { uri } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
    });

    expect(uri).toBe(
      'mongodb://platform:s3cret@mongo:27017/cleandb?authSource=admin',
    );
  });

  it('MUST URL-encode reserved characters in credentials', () => {
    const { uri } = buildMongoDbUri({
      mongoDbHost: 'mongo',
      mongoDbPort: 27017,
      mongoDbName: 'cleandb',
      mongoDbUser: 'user@corp',
      mongoDbPassword: 'p@ss:word/1',
    });

    expect(uri).toBe(
      'mongodb://user%40corp:p%40ss%3Aword%2F1@mongo:27017/cleandb?authSource=admin',
    );
  });

  it('MUST ignore a user without a password (and vice versa) in local mode', () => {
    expect(
      buildMongoDbUri({
        mongoDbHost: 'mongo',
        mongoDbPort: 27017,
        mongoDbName: 'cleandb',
        mongoDbUser: 'platform',
      }).uri,
    ).toBe('mongodb://mongo:27017/cleandb');

    expect(
      buildMongoDbUri({
        mongoDbHost: 'mongo',
        mongoDbPort: 27017,
        mongoDbName: 'cleandb',
        mongoDbPassword: 's3cret',
      }).uri,
    ).toBe('mongodb://mongo:27017/cleandb');
  });

  it('MUST keep the Atlas URI shape when mongoDbAtlas is set', () => {
    const { uri, message } = buildMongoDbUri({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'cleandb',
      mongoDbUser: 'platform',
      mongoDbPassword: 's3cret',
    });

    expect(uri).toBe(
      'mongodb+srv://platform:s3cret@cluster0.example.mongodb.net/cleandb?retryWrites=true&w=majority',
    );
    expect(message).toContain('Atlas');
  });

  it('MUST URL-encode reserved characters in Atlas credentials too', () => {
    const { uri } = buildMongoDbUri({
      mongoDbAtlas: true,
      mongoDbHost: 'cluster0.example.mongodb.net',
      mongoDbName: 'cleandb',
      mongoDbUser: 'user@corp',
      mongoDbPassword: 'p@ss:word/1',
    });

    expect(uri).toBe(
      'mongodb+srv://user%40corp:p%40ss%3Aword%2F1@cluster0.example.mongodb.net/cleandb?retryWrites=true&w=majority',
    );
  });
});
