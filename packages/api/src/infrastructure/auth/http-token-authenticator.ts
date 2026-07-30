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
}

/**
 * Auth System adapter — RFC 7662 token introspection. POSTs the caller's
 * token to {authSystemUrl}/introspect (authenticating as this module via
 * Basic) and reads ONLY `active`; every other claim the Auth System returns
 * is ignored by design (the module holds no scope/tenant logic). Anything
 * unexpected — non-200, network error, timeout, malformed body — counts as
 * NOT authenticated: fail closed.
 */
export class HttpTokenAuthenticator implements TokenAuthenticator {
  private readonly authSystemUrl: string;
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly timeoutMs: number;

  constructor(options: HttpTokenAuthenticatorOptions) {
    this.authSystemUrl = options.authSystemUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.timeoutMs = options.timeoutMs ?? 3000;
  }

  async isAuthenticated(token: string): Promise<boolean> {
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
      if (!response.ok) return false;
      const body = (await response.json()) as { active?: unknown };
      return body.active === true;
    } catch {
      return false;
    }
  }
}
