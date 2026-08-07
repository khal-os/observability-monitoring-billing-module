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
   * The silo's discovery base URL (ADR-97 — the khal-wide canonical surface):
   * with khalTenant, the Auth System URL is RESOLVED at runtime from
   * GET {url}/.well-known/registers?tenant={tenant} instead of being
   * configured directly. Setting it turns auth ON for /api/v1.
   */
  khalDiscoveryUrl?: string;
  /** The tenant this deployment belongs to (discovery doublecheck). */
  khalTenant?: string;
  /**
   * Base URL of the khal Auth System (M2M) — the pre-discovery form, kept as
   * the legacy alternative (ignored, with a log, when khalDiscoveryUrl is
   * set). When either surface is configured, every /api/v1 request must
   * carry a Bearer token the Auth System accepts (introspection —
   * authenticated-or-not only; the module never inspects claims, scopes or
   * tenant). Neither set → API open (PoC behavior).
   */
  authSystemUrl?: string;
  /** audit D-1: exact origins allowed cross-origin (comma-separated); unset = same-origin only. */
  corsAllowedOrigins?: string;
  /**
   * This module's own M2M credential — the Auth System's /introspect is a
   * protected endpoint (RFC 7662): the module must authenticate itself
   * (Basic) to ask "is this token active". Without it every introspection
   * fails closed (all requests 401). Canonical spelling KHAL_CLIENT_ID/
   * KHAL_CLIENT_SECRET; the AUTH_SYSTEM_CLIENT_* names are honored as
   * deprecated aliases of the SAME credential.
   */
  khalClientId?: string;
  khalClientSecret?: string;
}
