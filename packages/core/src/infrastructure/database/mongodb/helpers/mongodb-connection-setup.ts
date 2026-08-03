import { MongoClient, MongoClientOptions } from 'mongodb';
import { MongoDbEnvironmentVariables } from '../../../configuration/interfaces/mongodb-environment-variables.js';

/**
 * Durability and serialization pinned EXPLICITLY at client construction
 * (audit C-7.5) — never left to driver defaults or to which URI shape
 * happened to be built:
 * - `w: 'majority'` + `retryWrites: true`: the local URI carried neither
 *   (only the Atlas URI spelled them out); the permanent archive
 *   (invariant 6) and the billing writes ride this client.
 * - `ignoreUndefined: false`: the storage convention says optional fields
 *   are stored as NULL, never absent — that relies on the serializer
 *   turning `undefined` into null, which is exactly what this flag pins.
 * Options take precedence over URI params, so the Atlas URI's matching
 * `retryWrites=true&w=majority` stays consistent by construction.
 */
export const MONGO_CLIENT_OPTIONS: MongoClientOptions = {
  w: 'majority',
  retryWrites: true,
  ignoreUndefined: false,
};

export const buildMongoDbUri = ({
  mongoDbAtlas,
  mongoDbName,
  mongoDbUser,
  mongoDbPassword,
  mongoDbHost,
  mongoDbPort,
}: MongoDbEnvironmentVariables): { uri: string; message: string } => {
  if (mongoDbAtlas) {
    return {
      uri: `mongodb+srv://${encodeURIComponent(mongoDbUser ?? '')}:${encodeURIComponent(mongoDbPassword ?? '')}@${mongoDbHost}/${mongoDbName}?retryWrites=true&w=majority`,
      message: `MongoDB: Server is connected to "${mongoDbName}" database on Atlas!`,
    };
  }

  // Credentials are optional in local mode: absent in the auth-less dev
  // setup, present when the deployment's mongo enables auth (the root user
  // lives in the admin database, hence authSource).
  const credentials =
    mongoDbUser && mongoDbPassword
      ? `${encodeURIComponent(mongoDbUser)}:${encodeURIComponent(mongoDbPassword)}@`
      : '';
  const authSource = credentials ? '?authSource=admin' : '';

  return {
    uri: `mongodb://${credentials}${mongoDbHost}:${mongoDbPort}/${mongoDbName}${authSource}`,
    message: `MongoDB: Server is connected to "${mongoDbName}" database on port ${mongoDbPort}!`,
  };
};

export const setupMongoDbClient = (
  config: MongoDbEnvironmentVariables,
): {
  client: MongoClient;
  message: string;
} => {
  const { uri, message } = buildMongoDbUri(config);

  return { client: new MongoClient(uri, MONGO_CLIENT_OPTIONS), message };
};
