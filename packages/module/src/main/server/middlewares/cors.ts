import { NextFunction, Request, Response } from 'express';
import { config } from '../../../infrastructure/index.js';

/**
 * Same-origin by design (audit D-1): the shipped UI is served by nginx,
 * which proxies /api on the SAME origin — its own config says "no CORS,
 * no discovery" — and the platform integrates M2M server-side. The old
 * middleware sent `Access-Control-Allow-Origin: *` unconditionally, which
 * turned every browser into an exfiltration proxy for the unmasked
 * archive: with auth off (the PoC default) and the dashboard reachable on
 * a LAN, any web page the operator visited could fetch /api/v1/traces and
 * POST the transcripts offsite — the browser was the reachability.
 *
 * Cross-origin access is now an EXPLICIT operator act: CORS_ALLOWED_ORIGINS
 * (comma-separated exact origins) echoes a matching Origin back — never a
 * wildcard — with Vary: Origin for caches. Unset (the default), no CORS
 * header exists and browsers enforce same-origin.
 */
const allowedOrigins = new Set(
  (config.corsAllowedOrigins ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),
);

export const corsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.set('access-control-allow-origin', origin);
    res.set('access-control-allow-methods', 'GET,POST');
    res.set('access-control-allow-headers', 'Content-Type, Authorization');
  }

  // Caches must never serve one origin's answer to another.
  if (allowedOrigins.size > 0) {
    res.set('vary', 'Origin');
  }

  next();
};
