import express, { Express } from 'express';
import { ServerEnvironmentVariables } from '../../configuration/interfaces/index.js';
import { Server } from '../../interfaces/index.js';

export class ExpressServer implements Server {
  app: Express;
  field: number;

  constructor() {
    const app = express();

    this.app = app;
    this.field = 0;
  }

  async start(config: ServerEnvironmentVariables): Promise<void> {
    const serverPort = config.serverPort;

    this.app.listen(serverPort, () => {
      console.log(`Express: Server is running on port ${serverPort}!`);
    });

    this.field = 1;
  }

  async stop(): Promise<void> {
    // Implement logic to gracefully stop the server if needed
    console.log('Express: Server stopped successfully!');
  }
}
