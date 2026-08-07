import { makeDiscoveryAuthSystemUrl } from './discovery-auth-system-url.js';

const REGISTERS_BODY = {
  tenant: 'acme',
  environment: 'homolog',
  registers: {
    apps: 'https://apps.example',
    connectors: 'https://connectors.example',
    agents: 'https://agents.example',
    auth: { url: 'https://auth.example' },
  },
};

const responseWith = (body: unknown, maxAge?: number) => ({
  ok: true,
  headers: {
    get: (name: string) =>
      name === 'cache-control' && maxAge !== undefined
        ? `public, max-age=${String(maxAge)}`
        : null,
  },
  json: async () => body,
});

const withFetchReturning = (mock: jest.Mock) => {
  global.fetch = mock as unknown as typeof fetch;
};

describe('makeDiscoveryAuthSystemUrl', () => {
  const originalFetch = global.fetch;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('MUST GET /.well-known/registers with the tenant doublecheck and cache the auth URL', async () => {
    const mock = jest.fn().mockResolvedValue(responseWith(REGISTERS_BODY, 300));
    withFetchReturning(mock);
    const resolve = makeDiscoveryAuthSystemUrl({
      discoveryUrl: 'https://connectors.example/',
      tenant: 'acme',
      now,
    });

    await expect(resolve()).resolves.toBe('https://auth.example');
    await expect(resolve()).resolves.toBe('https://auth.example');
    expect(mock).toHaveBeenCalledTimes(1); // cached within max-age
    expect(mock).toHaveBeenCalledWith(
      'https://connectors.example/.well-known/registers?tenant=acme',
      expect.anything(),
    );
  });

  it('MUST re-resolve after the Cache-Control window lapses', async () => {
    const mock = jest
      .fn()
      .mockResolvedValue(responseWith(REGISTERS_BODY, 300));
    withFetchReturning(mock);
    const resolve = makeDiscoveryAuthSystemUrl({
      discoveryUrl: 'https://connectors.example',
      tenant: 'acme',
      now,
    });

    await resolve();
    clock += 301_000;
    await resolve();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('MUST answer undefined (fail closed) while discovery never resolved — throttling retries', async () => {
    const mock = jest.fn().mockRejectedValue(new Error('refused'));
    withFetchReturning(mock);
    const resolve = makeDiscoveryAuthSystemUrl({
      discoveryUrl: 'https://connectors.example',
      tenant: 'acme',
      now,
    });

    await expect(resolve()).resolves.toBeUndefined();
    await expect(resolve()).resolves.toBeUndefined(); // throttled: no second fetch
    expect(mock).toHaveBeenCalledTimes(1);
    clock += 16_000; // past the failure throttle
    await resolve();
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('MUST serve the last-known URL through a failed refresh (stale beats none)', async () => {
    const mock = jest
      .fn()
      .mockResolvedValueOnce(responseWith(REGISTERS_BODY, 300))
      .mockRejectedValueOnce(new Error('boom'));
    withFetchReturning(mock);
    const resolve = makeDiscoveryAuthSystemUrl({
      discoveryUrl: 'https://connectors.example',
      tenant: 'acme',
      now,
    });

    await expect(resolve()).resolves.toBe('https://auth.example');
    clock += 301_000;
    await expect(resolve()).resolves.toBe('https://auth.example'); // stale served
  });

  it('MUST treat a response without an auth URL as a failure', async () => {
    const mock = jest
      .fn()
      .mockResolvedValue(responseWith({ registers: { apps: 'x' } }));
    withFetchReturning(mock);
    const resolve = makeDiscoveryAuthSystemUrl({
      discoveryUrl: 'https://connectors.example',
      tenant: 'acme',
      now,
    });

    await expect(resolve()).resolves.toBeUndefined();
  });
});
