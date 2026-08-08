import {
  ListSessionFilterOptionsUseCase,
  SessionFilterOptions,
  SessionListFilters,
  SessionQueryRepository,
} from './query-sessions-protocols.js';
import { TtlCache } from '../../helpers/ttl-cache.js';

/**
 * Same short TTL cache as the traces dropdowns (decision 77): the counts
 * decorate a filter bar, ≤TTL staleness is fine, and the cache turns the
 * per-change facet scan of the summaries collection (~0.6s at 210k
 * sessions) into a memory lookup. TTL 0 disables (tests assert ground
 * truth).
 */
export class ListSessionFilterOptionsDbUseCase implements ListSessionFilterOptionsUseCase {
  private readonly sessionQueryRepository: SessionQueryRepository;
  private readonly cache: TtlCache<SessionFilterOptions>;

  constructor(args: {
    sessionQueryRepository: SessionQueryRepository;
    cacheTtlMs?: number;
  }) {
    this.sessionQueryRepository = args.sessionQueryRepository;
    this.cache = new TtlCache({ ttlMs: args.cacheTtlMs ?? 0 });
  }

  async list(filters: SessionListFilters): Promise<SessionFilterOptions> {
    if (!this.cache.enabled) {
      return this.sessionQueryRepository.findSessionFilterOptions(filters);
    }

    const key = JSON.stringify(filters);
    const cached = this.cache.get(key);

    if (cached) return cached;

    const value =
      await this.sessionQueryRepository.findSessionFilterOptions(filters);

    this.cache.set(key, value);

    return value;
  }
}
