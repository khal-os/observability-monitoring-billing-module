import { MongoClient } from 'mongodb';
import { MongoDbEnvironmentVariables } from '../../../configuration/interfaces/mongodb-environment-variables.js';

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

  return { client: new MongoClient(uri), message };
};
