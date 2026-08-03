import { TtlCache } from './ttl-cache.js';

describe('TtlCache (decision 77 — one cache semantics for every facet bar)', () => {
  it('MUST serve a fresh entry and miss after the TTL', () => {
    jest.useFakeTimers({ now: new Date('2026-07-19T12:00:00.000Z') });

    try {
      const cache = new TtlCache<string>({ ttlMs: 1_000 });
      cache.set('key', 'value');

      expect(cache.get('key')).toBe('value');

      jest.advanceTimersByTime(1_000);

      expect(cache.get('key')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('MUST be disabled at ttlMs 0 — never hits, `enabled` says so', () => {
    const cache = new TtlCache<string>({ ttlMs: 0 });
    cache.set('key', 'value');

    expect(cache.enabled).toBe(false);
    expect(cache.get('key')).toBeUndefined();
  });

  it('MUST evict the oldest-inserted entry at capacity', () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('MUST keep a hot key alive under eviction pressure (LRU refresh)', () => {
    const cache = new TtlCache<number>({ ttlMs: 60_000, maxEntries: 3 });
    cache.set('hot', 0);
    cache.set('b', 1);
    cache.set('c', 2);

    // Re-inserting the hot key moves it to the BACK of the eviction order —
    // without the refresh it would be first out, being the oldest insert.
    cache.set('hot', 3);

    cache.set('d', 4); // evicts 'b', the true oldest — not 'hot'
    cache.set('e', 5); // evicts 'c'

    expect(cache.get('hot')).toBe(3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeUndefined();
    expect(cache.get('d')).toBe(4);
    expect(cache.get('e')).toBe(5);
  });
});
