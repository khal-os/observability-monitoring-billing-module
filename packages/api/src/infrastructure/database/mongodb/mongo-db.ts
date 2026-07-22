import { MongoClient, UUID } from 'mongodb';
import { setupMongoDbClient } from './helpers/mongodb-connection-setup.js';
import { MongoDbEnvironmentVariables } from '../../configuration/interfaces/mongodb-environment-variables.js';

// The Database PORT (infrastructure/interfaces) is satisfied by the
// composition root's factory wrapping the static form below — the legacy
// instance methods predate the port and take config directly.
export class MongoDb {
  private static client?: MongoClient;
  private client?: MongoClient;
  static connectionId = '';
  connectionId = '';

  async connect(config: MongoDbEnvironmentVariables): Promise<void> {
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

    if (this.client) {
      console.warn(
        'MongoDB: Client is already connected. Skipping new connection.',
      );
      return;
    }

    try {
      await client.connect();
      console.log(message);

      this.client = client;
      this.connectionId = MongoDb.generateUUID();
    } catch (error) {
      console.error('MongoDB: Error connecting to MongoDB:', error);
      throw error;
    }
  }

  getClient(): MongoClient {
    if (!this.client) {
      throw new Error('MongoDB client is not connected.');
    }

    return this.client;
  }

  getCollection(collectionName: string) {
    if (!this.client) {
      throw new Error('MongoDB client is not connected.');
    }

    const dbName = this.client.db().databaseName;

    return this.client.db(dbName).collection(collectionName);
  }

  async disconnect(): Promise<void> {
    if (!this.client) {
      console.error('No MongoDB client to disconnect.');
      return;
    }

    try {
      await this.client.close();
      this.client = undefined;
      console.log('MongoDB: Connection closed successfully!');
    } catch (error) {
      console.error('MongoDB: Error disconnecting from MongoDB:', error);
      throw error;
    }
  }

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
}
