import {
  ListTraceFilterOptionsUseCase,
  TraceFilterOptions,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';
import { TtlCache } from '../../helpers/ttl-cache.js';

/**
 * Facet options with a short in-memory TTL (decision 77): dropdown counts
 * are decoration, refreshed by the UI every few seconds — a briefly stale
 * answer is fine, and the cache turns steady-state facet reads into
 * memory lookups even on pathological cube cardinality. TTL 0 disables
 * (tests assert cube ground truth without cache interference).
 */
export class ListTraceFilterOptionsDbUseCase
  implements ListTraceFilterOptionsUseCase
{
  private readonly traceQueryRepository: TraceQueryRepository;
  private readonly cache: TtlCache<TraceFilterOptions>;

  constructor(args: {
    traceQueryRepository: TraceQueryRepository;
    cacheTtlMs?: number;
  }) {
    this.traceQueryRepository = args.traceQueryRepository;
    this.cache = new TtlCache({ ttlMs: args.cacheTtlMs ?? 0 });
  }

  async list(filters: TraceListFilters): Promise<TraceFilterOptions> {
    if (!this.cache.enabled) {
      return this.traceQueryRepository.findFilterOptions(filters);
    }

    const key = JSON.stringify(filters);
    const cached = this.cache.get(key);

    if (cached) return cached;

    const value = await this.traceQueryRepository.findFilterOptions(filters);

    this.cache.set(key, value);

    return value;
  }
}
