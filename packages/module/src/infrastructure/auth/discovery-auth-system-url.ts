/**
 * Silo discovery (ADR-97) — resolves the Auth System URL from ONE configured
 * URL: GET {discoveryUrl}/.well-known/registers?tenant={tenant} (no auth,
 * cached per the endpoint's Cache-Control; the platform serves max-age=300).
 * Moving the Auth System to another host never requires redeploying this
 * module — the next resolve after the cache window picks the new URL up.
 *
 * FAIL CLOSED, unlike the agent-side discovery client: this URL guards the
 * API's front door, so "discovery never answered" must yield 401s (the
 * authenticator treats an undefined URL as an introspection error — uncached,
 * fail closed), never an open API. A last-known URL IS served while a refresh
 * fails (stale beats none — the Auth System did not move mid-failure), and
 * failed fetches are throttled so a broken discovery isn't polled per-request.
 */

export interface DiscoveryAuthSystemUrlOptions {
  discoveryUrl: string;
  tenant: string;
  timeoutMs?: number;
  /** Fallback cache TTL when the response carries no max-age (default 300s). */
  defaultTtlMs?: number;
  /** Wait between failed fetch attempts (default 15s). */
  failureRetryMs?: number;
  /** Injectable clock for tests (default Date.now). */
  now?: () => number;
}

/**
 * A cached, single-in-flight resolver: () => Promise<string | undefined>.
 * The shape matches HttpTokenAuthenticatorOptions.authSystemUrl's callable
 * form — construction wiring lives in main/factories/auth-factory.ts.
 */
export const makeDiscoveryAuthSystemUrl = (
  options: DiscoveryAuthSystemUrlOptions,
): (() => Promise<string | undefined>) => {
  const registersUrl = `${options.discoveryUrl.replace(/\/+$/, '')}/.well-known/registers?${new URLSearchParams({ tenant: options.tenant }).toString()}`;
  const timeoutMs = options.timeoutMs ?? 3000;
  const defaultTtlMs = options.defaultTtlMs ?? 300_000;
  const failureRetryMs = options.failureRetryMs ?? 15_000;
  const now = options.now ?? Date.now;

  let cachedUrl: string | undefined;
  let expiresAt = 0;
  let nextAttemptAt = 0;
  let inFlight: Promise<string | undefined> | undefined;

  const fetchUrl = async (): Promise<string | undefined> => {
    try {
      const response = await fetch(registersUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as {
        registers?: { auth?: { url?: unknown } };
      } | null;
      const url = body?.registers?.auth?.url;
      if (typeof url !== 'string' || url === '') {
        throw new Error('discovery response carries no auth URL');
      }
      const maxAge = /max-age=(\d+)/.exec(
        response.headers.get('cache-control') ?? '',
      );
      cachedUrl = url;
      expiresAt = now() + (maxAge ? Number(maxAge[1]) * 1000 : defaultTtlMs);
      return cachedUrl;
    } catch (error) {
      nextAttemptAt = now() + failureRetryMs;
      console.error(
        `khal discovery at ${registersUrl} failed (${String(error)}); ` +
          (cachedUrl
            ? 'serving the last-known Auth System URL'
            : 'introspection will fail closed') +
          `; retrying in ${String(failureRetryMs / 1000)}s`,
      );
      return cachedUrl; // stale when we have one; undefined = fail closed
    }
  };

  return async () => {
    const at = now();
    if (cachedUrl !== undefined && at < expiresAt) return cachedUrl;
    if (at < nextAttemptAt) return cachedUrl;
    inFlight ??= fetchUrl().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
};
