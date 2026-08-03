import { Request, Response } from 'express';
import {
  MethodNotAllowedError,
  NotFoundError,
} from '../../../presentation/errors/index.js';

/**
 * Known API routes, exactly as registered in routes/v1 (C-5.2). Static ON
 * PURPOSE — the same reasoning as v1-routes-setup.ts: a new route module
 * is one import + one line there, and one line here. `:param` segments
 * match any single path segment.
 */
const KNOWN_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/api/v1/traces' },
  { method: 'GET', path: '/api/v1/traces/filters' },
  { method: 'GET', path: '/api/v1/traces/:id' },
  { method: 'GET', path: '/api/v1/sessions' },
  { method: 'GET', path: '/api/v1/sessions/filters' },
  { method: 'GET', path: '/api/v1/sessions/:id' },
  { method: 'GET', path: '/api/v1/bills' },
  { method: 'GET', path: '/api/v1/billing/summary' },
  { method: 'GET', path: '/api/v1/billing/series' },
  { method: 'GET', path: '/api/v1/billing/projection' },
  { method: 'GET', path: '/api/v1/billing/statement' },
  { method: 'POST', path: '/api/v1/prices' },
];

const toMatcher = (path: string): RegExp =>
  new RegExp(
    `^${path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment))
      .join('/')}/?$`,
    // Express routing is case-INsensitive by default; this table must
    // match the router, or POST /API/V1/TRACES would answer 404 while
    // POST /api/v1/traces answers 405.
    'i',
  );

const ROUTE_MATCHERS = KNOWN_ROUTES.map((route) => ({
  method: route.method,
  matcher: toMatcher(route.path),
}));

/**
 * What the server ACTUALLY serves on this path — the table plus the HEAD
 * Express derives from every GET route (re-audit iteration 2). The table
 * lists only the methods registered by hand, so echoing it verbatim
 * answered `Allow: GET` while OPTIONS on the same path answered
 * `Allow: GET,HEAD` and HEAD genuinely reached the controller: two
 * discovery paths on one resource contradicting each other, and a client
 * caching the 405's list would never poll with HEAD. RFC 7231 §6.5.5 asks
 * for the methods the target resource supports, so the derived HEAD
 * belongs here. OPTIONS is deliberately NOT added: Express's own OPTIONS
 * handler does not list itself, and the two answers must report the SAME
 * method set (pinned by app-error-shape.test.ts).
 */
const allowedMethods = (path: string): string[] => {
  const methods = new Set(
    ROUTE_MATCHERS.filter((route) => route.matcher.test(path)).map(
      (route) => route.method,
    ),
  );

  if (methods.has('GET')) {
    methods.add('HEAD');
  }

  return [...methods];
};

/**
 * Catch-all registered AFTER every route: an unknown path answers 404; a
 * KNOWN path reached with the wrong method answers 405 + `Allow` (C-5.2 —
 * "there is no DELETE here" beats "this path does not exist"). Same
 * {name, msg} JSON error shape as the controllers in both cases — never
 * Express's HTML "Cannot GET" page.
 */
export const notFoundMiddleware = (req: Request, res: Response): void => {
  const allowed = allowedMethods(req.path);

  if (allowed.length > 0) {
    res
      .status(405)
      .set('Allow', allowed.join(', '))
      .json(new MethodNotAllowedError(`${req.method} ${req.path}`));
    return;
  }

  res.status(404).json(new NotFoundError(`${req.method} ${req.path}`));
};
