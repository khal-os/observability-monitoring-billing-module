/**
 * environment-setup parses process.env AT IMPORT TIME, so each case builds
 * its env, resets the module registry and re-imports. Pure unit suite — no
 * store, no server.
 *
 * What is pinned here:
 * - MONGO_DB_ATLAS arrives as a STRING ('true'/'false') and must map to a
 *   real boolean — z.boolean() would reject every set value and crash the
 *   boot (the Atlas branch was dead code).
 * - Compose forwards the KHAL_* quartet with `${VAR:-}` defaults, so an env
 *   file that omits them delivers EMPTY STRINGS to the container — which must
 *   behave exactly like unset (an empty URL must never half-enable auth).
 */
const ORIGINAL_ENV = process.env;

const loadEnvironment = async (
  overrides: Record<string, string> = {},
): Promise<typeof import('./environment-setup.js').environment> => {
  process.env = {
    ...ORIGINAL_ENV,
    ENVIRONMENT: 'test',
    SERVER_PORT: '3000',
  };
  delete process.env.MONGO_DB_ATLAS;
  delete process.env.KHAL_DISCOVERY_URL;
  delete process.env.KHAL_TENANT;
  delete process.env.KHAL_CLIENT_ID;
  delete process.env.KHAL_CLIENT_SECRET;
  Object.assign(process.env, overrides);

  jest.resetModules();
  const { environment } = await import('./environment-setup.js');
  return environment;
};

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('environment-setup', () => {
  describe('MONGO_DB_ATLAS (string env → boolean)', () => {
    it("MUST parse MONGO_DB_ATLAS='true' to boolean true", async () => {
      const environment = await loadEnvironment({ MONGO_DB_ATLAS: 'true' });

      expect(environment.mongoDbAtlas).toBe(true);
    });

    it("MUST parse MONGO_DB_ATLAS='false' to boolean false", async () => {
      const environment = await loadEnvironment({ MONGO_DB_ATLAS: 'false' });

      expect(environment.mongoDbAtlas).toBe(false);
    });

    it('MUST leave mongoDbAtlas undefined when the var is unset', async () => {
      const environment = await loadEnvironment();

      expect(environment.mongoDbAtlas).toBeUndefined();
    });
  });

  describe('KHAL_* (canonical khal consumer surface, ADR-97)', () => {
    it('MUST pass the quartet through unchanged', async () => {
      const environment = await loadEnvironment({
        KHAL_DISCOVERY_URL: 'http://connectors:7103',
        KHAL_TENANT: 'acme',
        KHAL_CLIENT_ID: 'observability-module',
        KHAL_CLIENT_SECRET: 's3cret',
      });

      expect(environment.khalDiscoveryUrl).toBe('http://connectors:7103');
      expect(environment.khalTenant).toBe('acme');
      expect(environment.khalClientId).toBe('observability-module');
      expect(environment.khalClientSecret).toBe('s3cret');
    });

    it("MUST treat '' (compose `${VAR:-}` defaults) as unset across the quartet", async () => {
      const environment = await loadEnvironment({
        KHAL_DISCOVERY_URL: '',
        KHAL_TENANT: '',
        KHAL_CLIENT_ID: '',
        KHAL_CLIENT_SECRET: '',
      });

      expect(environment.khalDiscoveryUrl).toBeUndefined();
      expect(environment.khalTenant).toBeUndefined();
      expect(environment.khalClientId).toBeUndefined();
      expect(environment.khalClientSecret).toBeUndefined();
    });
  });
});
