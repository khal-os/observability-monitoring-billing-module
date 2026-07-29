import express, { Express } from 'express';
import { Server as HttpServer } from 'http';
import { ServerEnvironmentVariables } from '../../configuration/interfaces/index.js';
import { Server } from '../../interfaces/index.js';

export class ExpressServer implements Server {
  app: Express;
  private httpServer?: HttpServer;

  constructor() {
    this.app = express();
  }

  async start(config: ServerEnvironmentVariables): Promise<void> {
    const serverPort = config.serverPort;

    this.httpServer = this.app.listen(serverPort, () => {
      console.log(`Express: Server is running on port ${serverPort}!`);
    });
  }

  async stop(): Promise<void> {
    const httpServer = this.httpServer;

    if (!httpServer) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });

    this.httpServer = undefined;
    console.log('Express: Server stopped successfully!');
  }
}
