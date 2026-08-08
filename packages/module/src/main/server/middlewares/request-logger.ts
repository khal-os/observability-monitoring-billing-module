import { NextFunction, Request, Response } from 'express';
import { Logger } from '@observability/core/common/logging/logger.js';

export const makeRequestLoggerMiddleware = (logger: Logger) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Docs also serve as the container healthcheck — logging them would
    // print a line every 15s per instance.
    if (req.path.startsWith('/api/v1/docs')) {
      next();
      return;
    }

    const startedAt = Date.now();

    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
};
