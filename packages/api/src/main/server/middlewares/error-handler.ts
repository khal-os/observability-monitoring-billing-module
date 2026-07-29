import { NextFunction, Request, Response } from 'express';
import {
  InvalidParamError,
  ServerError,
} from '../../../presentation/errors/index.js';

/**
 * Final error boundary: failures raised by middlewares (e.g. a malformed
 * JSON body rejected by the body parser) must answer in the same
 * {name, msg} JSON error shape as the controllers — never Express's HTML
 * error page, and never a stack trace, regardless of NODE_ENV.
 */
export const errorHandlerMiddleware = (
  error: Error & { status?: number; statusCode?: number },
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  // body-parser tags client faults with a 4xx status (malformed JSON,
  // bad charset, oversized payload…) — the request is the problem.
  const status = error.statusCode ?? error.status;
  if (status !== undefined && status >= 400 && status < 500) {
    res.status(400).json(new InvalidParamError('body'));
    return;
  }

  console.error('Unhandled middleware error:', error);
  res.status(500).json(new ServerError());
};
