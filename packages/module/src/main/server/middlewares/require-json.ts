import { NextFunction, Request, Response } from 'express';
import { UnsupportedMediaTypeError } from '../../../presentation/errors/index.js';

/**
 * 415 BEFORE the body parser (audit D-2): body-parser sets `req.body = {}`
 * BEFORE its own type check, so a correct price payload sent as
 * text/plain — or curl's default x-www-form-urlencoded — sailed through
 * as an EMPTY body and the controller answered "Missing parameter:
 * model" about a request whose model was present. The operator then
 * debugged the payload, the price never landed, pending_price traces
 * stayed unstamped and the month could not close (T6). The honest answer
 * names the actual problem. Answered directly, not via next(err): the
 * error boundary flattens middleware 4xx into 400 (same rule as auth).
 */
export const requireJsonMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const hasBodyMethod = ['POST', 'PUT', 'PATCH'].includes(req.method);
  const declaredType = req.get('content-type');

  // 415 is about an unsupported BODY representation: a bodyless request
  // declares no content-type and must fall through to routing — a POST on
  // a GET-only path stays a 405, and a bodyless POST /prices stays a 400
  // (nothing was sent, so "missing parameter" is the honest diagnosis).
  if (!hasBodyMethod || !declaredType || req.is('application/json')) {
    next();

    return;
  }

  res.status(415).json(new UnsupportedMediaTypeError(declaredType));
};
