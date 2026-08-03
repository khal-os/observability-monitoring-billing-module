import { NextFunction, Request, Response } from 'express';
import { config } from '../../infrastructure/index.js';
import { HttpTokenAuthenticator } from '../../infrastructure/auth/http-token-authenticator.js';
import { buildAuthMiddleware } from '../server/middlewares/index.js';

/** Auth is ON only when the deployment points at an Auth System. */
export const makeAuthMiddleware = (): ((
  req: Request,
  res: Response,
  next: NextFunction,
) => void) => {
  if (!config.authSystemUrl) return buildAuthMiddleware(undefined);

  if (!config.authSystemClientId || !config.authSystemClientSecret) {
    // Introspection is a protected endpoint — without the module's own
    // credential every check fails closed, i.e. ALL requests answer 401.
    // Loud at boot so the misconfiguration isn't diagnosed one 401 at a time.
    console.error(
      'AUTH_SYSTEM_URL is set but AUTH_SYSTEM_CLIENT_ID/AUTH_SYSTEM_CLIENT_SECRET ' +
        'are not — every /api/v1 request will answer 401 (fail closed).',
    );
  }

  return buildAuthMiddleware(
    new HttpTokenAuthenticator({
      authSystemUrl: config.authSystemUrl,
      clientId: config.authSystemClientId,
      clientSecret: config.authSystemClientSecret,
    }),
  );
};
