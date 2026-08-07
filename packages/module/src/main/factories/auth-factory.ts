import { NextFunction, Request, Response } from 'express';
import { config } from '../../infrastructure/index.js';
import { HttpTokenAuthenticator } from '../../infrastructure/auth/http-token-authenticator.js';
import { makeDiscoveryAuthSystemUrl } from '../../infrastructure/auth/discovery-auth-system-url.js';
import { buildAuthMiddleware } from '../server/middlewares/index.js';

/**
 * Auth is ON when the deployment points at the platform — the canonical
 * khal surface (KHAL_DISCOVERY_URL + KHAL_TENANT, ADR-97: the Auth System
 * URL is resolved from /.well-known/registers). Unset → API open (PoC
 * behavior).
 */
export const makeAuthMiddleware = (): ((
  req: Request,
  res: Response,
  next: NextFunction,
) => void) => {
  const discoveryUrl = config.khalDiscoveryUrl;
  if (!discoveryUrl) {
    return buildAuthMiddleware(undefined);
  }

  const tenant = config.khalTenant;
  if (!tenant) {
    // Discovery needs the tenant doublecheck. Auth was INTENDED — fail
    // closed (an unresolvable URL 401s everything), never silently open.
    console.error(
      'KHAL_DISCOVERY_URL is set but KHAL_TENANT is not — discovery cannot ' +
        'resolve the Auth System, so every /api/v1 request will answer 401 ' +
        '(fail closed).',
    );
  }
  if (!config.khalClientId || !config.khalClientSecret) {
    // Introspection is a protected endpoint — without the module's own
    // credential every check fails closed, i.e. ALL requests answer 401.
    // Loud at boot so the misconfiguration isn't diagnosed one 401 at a time.
    console.error(
      'the khal platform is configured but KHAL_CLIENT_ID/KHAL_CLIENT_SECRET ' +
        'are not — every /api/v1 request will answer 401 (fail closed).',
    );
  }

  const authSystemUrl = tenant
    ? makeDiscoveryAuthSystemUrl({ discoveryUrl, tenant })
    : async () => undefined;

  return buildAuthMiddleware(
    new HttpTokenAuthenticator({
      authSystemUrl,
      clientId: config.khalClientId,
      clientSecret: config.khalClientSecret,
    }),
  );
};
