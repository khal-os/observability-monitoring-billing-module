import { HttpTokenAuthenticator } from './http-token-authenticator.js';

const makeSut = (overrides?: { clientId?: string; clientSecret?: string }) =>
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

    await makeSut({ clientId: undefined, clientSecret: undefined }).isAuthenticated('tkn');

    expect(mock.mock.calls[0][1].headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded',
    });
  });

  it('MUST answer false when the Auth System says active: false', async () => {
    withFetchReturning(
      jest.fn().mockResolvedValue({ ok: true, json: async () => ({ active: false }) }),
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
});
