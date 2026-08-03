const DEFAULT_MAX_ENTRIES = 100;

/**
 * Small in-memory TTL cache shared by the facet-options use cases
 * (decision 77). ONE semantics for every consumer: entries expire after
 * `ttlMs`; the entry count is bounded (oldest-inserted evicted first);
 * and re-inserting an existing key moves it to the back of the eviction
 * order, so a hot key is never the first evicted (LRU refresh).
 *
 * ttlMs <= 0 disables the cache entirely (`enabled` is false and `get`
 * never hits) — tests assert ground truth without cache interference.
 */
export class TtlCache<Value> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, { at: number; value: Value }>();

  constructor(args: { ttlMs: number; maxEntries?: number }) {
    this.ttlMs = args.ttlMs;
    this.maxEntries = args.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  get(key: string): Value | undefined {
    const entry = this.entries.get(key);

    if (entry && Date.now() - entry.at < this.ttlMs) {
      return entry.value;
    }

    return undefined;
  }

  set(key: string, value: Value): void {
    // Delete-before-reinsert: a refreshed key re-enters at the back of the
    // Map's insertion order, which is the eviction order.
    this.entries.delete(key);

    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;

      if (oldest !== undefined) this.entries.delete(oldest);
    }

    this.entries.set(key, { at: Date.now(), value });
  }
}
