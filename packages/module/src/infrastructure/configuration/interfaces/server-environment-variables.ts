type ServerPort = number;

export interface ServerEnvironmentVariables {
  serverPort: ServerPort;
  /**
   * Deployment display name (the client this single-tenant instance serves),
   * injected by the stack's env — the code stays client-agnostic. Optional:
   * absent in tests/bare dev runs.
   */
  clientName?: string;
  /** REQUIRED (decision 130): the client's business timezone, IANA name. */
  clientTimezone: string;
  /**
   * Base URL of the khal Auth System (M2M). When set, every /api/v1 request
   * must carry a Bearer token the Auth System accepts (introspection —
   * authenticated-or-not only; the module never inspects claims, scopes or
   * tenant). Unset → API open (PoC behavior).
   */
  authSystemUrl?: string;
  /** audit D-1: exact origins allowed cross-origin (comma-separated); unset = same-origin only. */
  corsAllowedOrigins?: string;
  /**
   * This module's own M2M credential — the Auth System's /introspect is a
   * protected endpoint (RFC 7662): the module must authenticate itself
   * (Basic) to ask "is this token active". Without them every introspection
   * fails closed (all requests 401).
   */
  authSystemClientId?: string;
  authSystemClientSecret?: string;
}
