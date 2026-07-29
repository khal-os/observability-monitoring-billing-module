import {
  ListSessionFilterOptionsUseCase,
  SessionFilterOptions,
  SessionListFilters,
  SessionQueryRepository,
} from './query-sessions-protocols.js';

const MAX_CACHE_ENTRIES = 100;

/**
 * Same short TTL cache as the traces dropdowns (decision 77): the counts
 * decorate a filter bar, ≤TTL staleness is fine, and the cache turns the
 * per-change facet scan of the summaries collection (~0.6s at 210k
 * sessions) into a memory lookup. TTL 0 disables (tests assert ground
 * truth). Re-inserting a hit key moves it to the back of the eviction
 * order, so a hot key is never the first evicted.
 */
export class ListSessionFilterOptionsDbUseCase
  implements ListSessionFilterOptionsUseCase
{
  private readonly sessionQueryRepository: SessionQueryRepository;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<
    string,
    { at: number; value: SessionFilterOptions }
  >();

  constructor(args: {
    sessionQueryRepository: SessionQueryRepository;
    cacheTtlMs?: number;
  }) {
    this.sessionQueryRepository = args.sessionQueryRepository;
    this.cacheTtlMs = args.cacheTtlMs ?? 0;
  }

  async list(filters: SessionListFilters): Promise<SessionFilterOptions> {
    if (this.cacheTtlMs <= 0) {
      return this.sessionQueryRepository.findSessionFilterOptions(filters);
    }

    const key = JSON.stringify(filters);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.value;
    }

    const value =
      await this.sessionQueryRepository.findSessionFilterOptions(filters);

    this.cache.delete(key);
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });

    return value;
  }
}
