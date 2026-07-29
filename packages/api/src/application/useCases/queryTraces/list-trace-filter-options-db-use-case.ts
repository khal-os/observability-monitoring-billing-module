import {
  ListTraceFilterOptionsUseCase,
  TraceFilterOptions,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';

const MAX_CACHE_ENTRIES = 100;

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
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<
    string,
    { at: number; value: TraceFilterOptions }
  >();

  constructor(args: {
    traceQueryRepository: TraceQueryRepository;
    cacheTtlMs?: number;
  }) {
    this.traceQueryRepository = args.traceQueryRepository;
    this.cacheTtlMs = args.cacheTtlMs ?? 0;
  }

  async list(filters: TraceListFilters): Promise<TraceFilterOptions> {
    if (this.cacheTtlMs <= 0) {
      return this.traceQueryRepository.findFilterOptions(filters);
    }

    const key = JSON.stringify(filters);
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.value;
    }

    const value = await this.traceQueryRepository.findFilterOptions(filters);

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Oldest-in first out — plenty for a dropdown bar's combo space.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });

    return value;
  }
}
