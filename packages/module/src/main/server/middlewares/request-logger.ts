import { NextFunction, Request, Response } from 'express';

export const requestLoggerMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Docs also serve as the container healthcheck — logging them would print
  // a line every 15s per instance.
  if (req.path.startsWith('/api/v1/docs')) {
    next();
    return;
  }

  const startedAt = Date.now();

  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`,
    );
  });

  next();
};
