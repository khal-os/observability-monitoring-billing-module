import {
  HttpTokenAuthenticator,
  MAX_CACHE_ENTRIES,
} from './http-token-authenticator.js';

const makeSut = (overrides?: {
  clientId?: string;
  clientSecret?: string;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}) =>
  new HttpTokenAuthenticator({
    authSystemUrl: 'http://auth.local/',
    clientId: 'module-client',
    clientSecret: 'module-secret',
    ...overrides,
  });

const withFetchReturning = (mock: jest.Mock) => {
  global.fetch = mock as unknown as typeof fetch;
};

describe('HttpTokenAuthenticator', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('MUST POST the token to {authSystemUrl}/introspect form-encoded, authenticating itself via Basic (RFC 7662)', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true }),
    });
    withFetchReturning(mock);

    const result = await makeSut().isAuthenticated('tkn');

    expect(result).toBe(true);
    expect(mock).toHaveBeenCalledWith(
      'http://auth.local/introspect',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from('module-client:module-secret').toString('base64')}`,
        },
        body: 'token=tkn',
      }),
    );
  });

  it('MUST omit the Basic header when the module has no credential (introspection then fails closed server-side)', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true }),
    });
    withFetchReturning(mock);

    await makeSut({
      clientId: undefined,
      clientSecret: undefined,
    }).isAuthenticated('tkn');

    expect(mock.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
  });

  it('MUST answer false when the Auth System says active: false', async () => {
    withFetchReturning(
      jest
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ active: false }) }),
    );

    expect(await makeSut().isAuthenticated('tkn')).toBe(false);
  });

  it('MUST fail closed on a non-200 answer', async () => {
    withFetchReturning(jest.fn().mockResolvedValue({ ok: false, status: 401 }));

    expect(await makeSut().isAuthenticated('tkn')).toBe(false);
  });

  it('MUST fail closed on a network error', async () => {
    withFetchReturning(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    expect(await makeSut().isAuthenticated('tkn')).toBe(false);
  });

  it('MUST fail closed on a malformed body', async () => {
    withFetchReturning(
      jest.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new Error('invalid json');
        },
      }),
    );

    expect(await makeSut().isAuthenticated('tkn')).toBe(false);
  });

  describe('introspection cache (C-4.2)', () => {
    const activeAnswer = (active: boolean) => ({
      ok: true,
      json: async () => ({ active }),
    });

    it('MUST serve a repeated token from the cache within the positive TTL (one fetch, not two)', async () => {
      const mock = jest.fn().mockResolvedValue(activeAnswer(true));
      withFetchReturning(mock);
      let clock = 0;
      const sut = makeSut({ positiveTtlMs: 30_000, now: () => clock });

      expect(await sut.isAuthenticated('tkn')).toBe(true);
      clock = 29_999;
      expect(await sut.isAuthenticated('tkn')).toBe(true);

      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('MUST re-introspect once the positive TTL expires', async () => {
      const mock = jest.fn().mockResolvedValue(activeAnswer(true));
      withFetchReturning(mock);
      let clock = 0;
      const sut = makeSut({ positiveTtlMs: 30_000, now: () => clock });

      await sut.isAuthenticated('tkn');
      clock = 30_000;
      await sut.isAuthenticated('tkn');

      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('MUST cache a definitive active:false for the SHORTER negative TTL', async () => {
      const mock = jest.fn().mockResolvedValue(activeAnswer(false));
      withFetchReturning(mock);
      let clock = 0;
      const sut = makeSut({
        positiveTtlMs: 30_000,
        negativeTtlMs: 5_000,
        now: () => clock,
      });

      expect(await sut.isAuthenticated('tkn')).toBe(false);
      clock = 4_999;
      expect(await sut.isAuthenticated('tkn')).toBe(false);
      expect(mock).toHaveBeenCalledTimes(1);

      // Past the negative TTL (well inside the positive one): re-asks —
      // a token activated meanwhile is honored within ~5s, not ~30s.
      clock = 5_000;
      await sut.isAuthenticated('tkn');
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('MUST share ONE in-flight introspection between concurrent checks of the same token', async () => {
      let release!: (value: {
        ok: boolean;
        json: () => Promise<unknown>;
      }) => void;
      const mock = jest.fn().mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        }),
      );
      withFetchReturning(mock);
      const sut = makeSut();

      const first = sut.isAuthenticated('tkn');
      const second = sut.isAuthenticated('tkn');

      release(activeAnswer(true));

      expect(await first).toBe(true);
      expect(await second).toBe(true);
      expect(mock).toHaveBeenCalledTimes(1);
    });

    it('MUST NOT cache errors: each attempt re-asks and fails closed', async () => {
      const mock = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      withFetchReturning(mock);
      const sut = makeSut({ now: () => 0 });

      expect(await sut.isAuthenticated('tkn')).toBe(false);
      expect(await sut.isAuthenticated('tkn')).toBe(false);

      // Two calls, two fetches — an auth-system blip never sticks.
      expect(mock).toHaveBeenCalledTimes(2);

      // And the recovery is immediate: the next attempt gets the truth.
      mock.mockResolvedValue(activeAnswer(true));
      expect(await sut.isAuthenticated('tkn')).toBe(true);
    });

    it('MUST treat a 200 without a boolean `active` as an error — fail closed NOW, nothing cached (RFC 7662)', async () => {
      const mock = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce(activeAnswer(true));
      withFetchReturning(mock);
      const sut = makeSut({ negativeTtlMs: 5_000, now: () => 0 });

      // The malformed 200 fails closed for THIS request…
      expect(await sut.isAuthenticated('tkn')).toBe(false);
      // …but wrote NO 5s negative entry: with the clock unmoved, the very
      // next attempt re-asks and the good token is honored immediately.
      expect(await sut.isAuthenticated('tkn')).toBe(true);
      expect(mock).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache bound', () => {
    const activeAnswer = (active: boolean) => ({
      ok: true,
      json: async () => ({ active }),
    });

    it('MUST cap the cache at MAX_CACHE_ENTRIES: the oldest entry is evicted, later ones survive', async () => {
      const mock = jest.fn().mockResolvedValue(activeAnswer(true));
      withFetchReturning(mock);
      const sut = makeSut({ now: () => 0 });

      for (let i = 0; i < MAX_CACHE_ENTRIES + 1; i += 1) {
        await sut.isAuthenticated(`tkn-${i}`);
      }
      expect(mock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);
      expect(sut['cache'].size).toBe(MAX_CACHE_ENTRIES);

      // tkn-1 survived the eviction: served from cache, no new fetch…
      await sut.isAuthenticated('tkn-1');
      expect(mock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 1);

      // …but tkn-0 (oldest-inserted) was evicted to make room: re-asks.
      await sut.isAuthenticated('tkn-0');
      expect(mock).toHaveBeenCalledTimes(MAX_CACHE_ENTRIES + 2);
    });

    it('MUST sweep expired entries on insert — a garbage-token flood leaves no residue past the TTL', async () => {
      const mock = jest.fn().mockResolvedValue(activeAnswer(false));
      withFetchReturning(mock);
      let clock = 0;
      const sut = makeSut({ negativeTtlMs: 5_000, now: () => clock });

      await sut.isAuthenticated('garbage-1');
      await sut.isAuthenticated('garbage-2');
      expect(sut['cache'].size).toBe(2);

      // Past the negative TTL, ONE fresh insert pops both dead entries.
      clock = 5_000;
      await sut.isAuthenticated('garbage-3');
      expect(sut['cache'].size).toBe(1);
    });
  });
});

describe('HttpTokenAuthenticator — resolver-form authSystemUrl (khal discovery)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('MUST introspect against the RESOLVED URL when authSystemUrl is a callable', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true }),
    });
    withFetchReturning(mock);

    const sut = new HttpTokenAuthenticator({
      authSystemUrl: async () => 'http://resolved-auth.local',
      clientId: 'module-client',
      clientSecret: 'module-secret',
    });

    await expect(sut.isAuthenticated('tkn')).resolves.toBe(true);
    expect(mock).toHaveBeenCalledWith(
      'http://resolved-auth.local/introspect',
      expect.anything(),
    );
  });

  it('MUST fail closed — and NOT cache — while the resolver answers undefined (discovery down)', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: true }),
    });
    withFetchReturning(mock);

    const urls: (string | undefined)[] = [
      undefined,
      'http://resolved-auth.local',
    ];
    const sut = new HttpTokenAuthenticator({
      authSystemUrl: async () => urls.shift(),
      clientId: 'module-client',
      clientSecret: 'module-secret',
    });

    await expect(sut.isAuthenticated('tkn')).resolves.toBe(false); // unresolved → 401
    expect(mock).not.toHaveBeenCalled(); // no URL, no introspection call
    await expect(sut.isAuthenticated('tkn')).resolves.toBe(true); // uncached: next request re-asks
  });
});
