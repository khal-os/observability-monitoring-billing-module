import { Request, Response } from 'express';
import {
  MethodNotAllowedError,
  NotFoundError,
} from '../../../presentation/errors/index.js';

/** One served route, exactly as the router registered it. */
export interface RegisteredRoute {
  method: string;
  path: string;
}

/**
 * audit D-4: this table used to be a HAND-MAINTAINED literal ("a new route
 * module is one import + one line there, and one line here") — the repo's
 * own named root-cause pattern, one rule in two spellings, at the API's
 * front door. A forgotten line made a served route answer 405 while the
 * router served it, and RFC 7231 §7.4.1 lets a client cache that Allow
 * list. The table now arrives DERIVED from the express router at setup
 * (see v1-routes-setup.ts); this module only compiles the matchers.
 * `:param` segments match any single path segment.
 */
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

/**
 * What the server ACTUALLY serves on this path — the derived table plus
 * the HEAD Express derives from every GET route (re-audit iteration 2).
 * RFC 7231 §6.5.5 asks for the methods the target resource supports, so
 * the derived HEAD belongs here. OPTIONS is deliberately NOT added:
 * Express's own OPTIONS handler does not list itself, and the two answers
 * must report the SAME method set (pinned by app-error-shape.test.ts).
 */
export const makeNotFoundMiddleware = (routes: RegisteredRoute[]) => {
  const matchers = routes.map((route) => ({
    method: route.method,
    matcher: toMatcher(route.path),
  }));

  const allowedMethods = (path: string): string[] => {
    const methods = new Set(
      matchers
        .filter((route) => route.matcher.test(path))
        .map((route) => route.method),
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
  return (req: Request, res: Response): void => {
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
};
