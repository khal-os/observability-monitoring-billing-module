import { retryOnceOnDuplicateKey } from './retry-once-on-duplicate-key.js';

/** The driver's unique-index violation, in the shape the adapters see. */
const duplicateKeyError = (): Error =>
  Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });

describe('retryOnceOnDuplicateKey (re-audit 2026-08, sync minors)', () => {
  it('MUST NOT retry a write that succeeded', async () => {
    const write = jest.fn().mockResolvedValue(undefined);

    await retryOnceOnDuplicateKey(write);

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('MUST retry ONCE when two writers race into the first-touch upsert — the second pass updates', async () => {
    const write = jest
      .fn()
      .mockRejectedValueOnce(duplicateKeyError())
      .mockResolvedValueOnce(undefined);

    await expect(retryOnceOnDuplicateKey(write)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('MUST surface a second duplicate — one retry, never a loop', async () => {
    const write = jest.fn().mockRejectedValue(duplicateKeyError());

    await expect(retryOnceOnDuplicateKey(write)).rejects.toThrow(/E11000/);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('MUST NOT swallow any other failure — only E11000 is a race', async () => {
    const write = jest.fn().mockRejectedValue(new Error('store unreachable'));

    await expect(retryOnceOnDuplicateKey(write)).rejects.toThrow(
      /store unreachable/,
    );
    expect(write).toHaveBeenCalledTimes(1);
  });
});
