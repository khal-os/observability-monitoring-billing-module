import { NextFunction, Request, Response } from 'express';

/**
 * Default cache posture for /api/v1 (audit D-7): NOTHING had a directive —
 * trace detail served full unmasked LLM transcripts with no `no-store`, so
 * on a shared workstation they persisted in the browser's disk cache and
 * back/forward history after the tab closed; and the HTML statement is
 * rendered inline, so `nosniff` belongs on everything too.
 *
 * `no-store` is the DEFAULT, not the law: a controller may override via
 * HttpResponse.headers (the adapter applies them after this) — a CLOSED
 * month is immutable by invariant 8 and says so with max-age + ETag.
 */
export const cacheHeadersMiddleware = (
  _req: Request,
  res: Response,
  next: NextFunction,
): void => {
  res.set('cache-control', 'no-store');
  res.set('x-content-type-options', 'nosniff');
  next();
};
