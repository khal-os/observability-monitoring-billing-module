type ServerPort = number;

export interface ServerEnvironmentVariables {
  serverPort: ServerPort;
  /**
   * Deployment display name (the client this single-tenant instance serves),
   * injected by the stack's env — the code stays client-agnostic. Optional:
   * absent in tests/bare dev runs.
   */
  clientName?: string;
}
