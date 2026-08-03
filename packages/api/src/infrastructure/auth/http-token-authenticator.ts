import { createHash } from 'node:crypto';
import { TokenAuthenticator } from '../../application/interfaces/token-authenticator.js';

export interface HttpTokenAuthenticatorOptions {
  authSystemUrl: string;
  /**
   * The module's own M2M credential: /introspect is a PROTECTED endpoint
   * (RFC 7662 §2.1) — the Auth System answers invalid_client unless the
   * caller authenticates (Basic). Absent credential → every introspection
   * fails closed.
   */
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  /** TTL for a cached `active: true` verdict (default 30s). */
  positiveTtlMs?: number;
  /** TTL for a cached definitive negative (default 5s — recovers fast). */
  negativeTtlMs?: number;
  /** Injectable clock for tests (default Date.now). */
  now?: () => number;
}

interface CachedVerdict {
  authenticated: boolean;
  expiresAt: number;
}

/**
 * Auth System adapter — RFC 7662 token introspection. POSTs the caller's
 * token to {authSystemUrl}/introspect (authenticating as this module via
 * Basic) and reads ONLY `active`; every other claim the Auth System returns
 * is ignored by design (the module holds no scope/tenant logic). Anything
 * unexpected — non-200, network error, timeout, malformed body — counts as
 * NOT authenticated: fail closed.
 *
 * Caching (C-4.2): without it every API request costs one auth-system
 * round trip — a stampede on parallel dashboard loads and a hard
 * availability coupling. An in-memory TTL cache keyed by the SHA-256 of
 * the token (never the raw token) stores DEFINITIVE introspection results
 * only: `active: true` for ~30s, `active: false` for ~5s. Errors are
 * NEVER cached — each attempt re-asks and fails closed, so an auth-system
 * blip is retried on the very next request. Concurrent checks of the same
 * token share one in-flight introspection.
 */
export class HttpTokenAuthenticator implements TokenAuthenticator {
  private readonly authSystemUrl: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly timeoutMs: number;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedVerdict>();
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(options: HttpTokenAuthenticatorOptions) {
    this.authSystemUrl = options.authSystemUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.positiveTtlMs = options.positiveTtlMs ?? 30_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  async isAuthenticated(token: string): Promise<boolean> {
    const key = createHash('sha256').update(token).digest('hex');

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.authenticated;
    }
    this.cache.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const check = this.introspect(token)
      .then((verdict) => {
        // Only a definitive Auth System answer is cacheable; an error
        // (undefined) answers false NOW but leaves nothing behind.
        if (verdict !== undefined) {
          this.cache.set(key, {
            authenticated: verdict,
            expiresAt:
              this.now() +
              (verdict ? this.positiveTtlMs : this.negativeTtlMs),
          });
        }
        return verdict === true;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, check);

    return check;
  }

  /** true/false = definitive introspection result; undefined = error (uncached, fail closed). */
  private async introspect(token: string): Promise<boolean | undefined> {
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
      };
      if (this.clientId && this.clientSecret) {
        headers.authorization = `Basic ${Buffer.from(
          `${this.clientId}:${this.clientSecret}`,
        ).toString('base64')}`;
      }

      const response = await fetch(
        `${this.authSystemUrl.replace(/\/+$/, '')}/introspect`,
        {
          method: 'POST',
          headers,
          body: new URLSearchParams({ token }).toString(),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { active?: unknown };
      return body.active === true;
    } catch {
      return undefined;
    }
  }
}
