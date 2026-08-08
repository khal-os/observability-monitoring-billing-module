import express, { Express } from 'express';
import { Server as HttpServer } from 'http';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';
import { ServerEnvironmentVariables } from '../../configuration/interfaces/index.js';
import { Server } from '../../interfaces/index.js';

export class ExpressServer implements Server {
  app: Express;
  private httpServer?: HttpServer;
  private readonly logger: Logger;

  constructor(logger: Logger = nullLogger) {
    this.app = express();
    this.logger = logger;
  }

  async start(config: ServerEnvironmentVariables): Promise<void> {
    const serverPort = config.serverPort;

    this.httpServer = this.app.listen(serverPort, () => {
      this.logger.info('Express: server is running', { port: serverPort });
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
    this.logger.info('Express: server stopped');
  }
}
