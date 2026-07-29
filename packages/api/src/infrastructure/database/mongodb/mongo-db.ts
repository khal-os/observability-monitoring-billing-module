import { ClientSession, MongoClient, UUID } from 'mongodb';
import { setupMongoDbClient } from './helpers/mongodb-connection-setup.js';
import { MongoDbEnvironmentVariables } from '../../configuration/interfaces/mongodb-environment-variables.js';

// PER-PROCESS singleton: one shared client per Node process (api server,
// each job, the trace-ingestion-worker are separate processes — so separate
// connections). The Database PORT (infrastructure/interfaces) is satisfied
// by the composition root's factory wrapping this static form; lifecycle
// (connect/disconnect) is called ONLY by entry points whose process owns
// the connection — repositories reach data through getCollection alone.
// (A legacy per-instance form used to live here too; deleted — nothing
// ever constructed it, and two contradictory lifetime stories in one
// class invited exactly the mixed-form bugs the singleton avoids.)
export class MongoDb {
  private static client?: MongoClient;
  static connectionId = '';

  static async connect(config: MongoDbEnvironmentVariables): Promise<void> {
    const {
      client,
      message,
    }: {
      client: MongoClient;
      message: string;
    } = setupMongoDbClient({
      mongoDbAtlas: config.mongoDbAtlas,
      mongoDbName: config.mongoDbName,
      mongoDbUser: config.mongoDbUser,
      mongoDbPassword: config.mongoDbPassword,
      mongoDbHost: config.mongoDbHost,
      mongoDbPort: config.mongoDbPort,
    });

    if (MongoDb.client) {
      console.warn(
        'MongoDB: Client is already connected. Skipping new connection.',
      );
      return;
    }

    try {
      await client.connect();
      console.log(message);

      MongoDb.client = client;
      MongoDb.connectionId = MongoDb.generateUUID();
    } catch (error) {
      console.error('MongoDB: Error connecting to MongoDB:', error);
      throw error;
    }
  }
  static getClient(): MongoClient {
    if (!MongoDb.client) {
      throw new Error('MongoDB client is not connected.');
    }

    return MongoDb.client;
  }

  static async connectWithUri(uri: string): Promise<void> {
    if (MongoDb.client) {
      console.warn(
        'MongoDB: Client is already connected. Skipping new connection.',
      );
      return;
    }

    try {
      const client = new MongoClient(uri);

      await client.connect();

      MongoDb.client = client;
      MongoDb.connectionId = MongoDb.generateUUID();
    } catch (error) {
      console.error('MongoDB: Error connecting to MongoDB:', error);
      throw error;
    }
  }

  static async disconnect(): Promise<void> {
    if (!MongoDb.client) {
      console.error('No MongoDB client to disconnect.');
      return;
    }

    try {
      await MongoDb.client.close();
      MongoDb.client = undefined;
      console.log('MongoDB: Connection closed successfully!');
    } catch (error) {
      console.error('MongoDB: Error disconnecting from MongoDB:', error);
      throw error;
    }
  }

  static getCollection(collectionName: string) {
    if (!MongoDb.client) {
      throw new Error('MongoDB client is not connected.');
    }

    const dbName = MongoDb.client.db().databaseName;

    return MongoDb.client.db(dbName).collection(collectionName);
  }

  static generateUUID(): string {
    return new UUID().toString();
  }

  /**
   * Multi-document transaction (decision 81) — requires the server to be
   * a replica set (compose runs mongo as a single-node RS; the jest
   * memory server is configured likewise). withTransaction retries
   * transient errors and commits with majority concern; the callback must
   * pass the session into every operation it wants inside the boundary.
   */
  static async withTransaction<T>(
    fn: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = MongoDb.getClient().startSession();

    try {
      return await session.withTransaction(fn);
    } finally {
      await session.endSession();
    }
  }
}
