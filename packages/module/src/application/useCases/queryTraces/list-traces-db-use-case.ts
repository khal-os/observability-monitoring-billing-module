import {
  ListTracesUseCase,
  Paginated,
  Pagination,
  PriceVersionRepository,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';
import { withDerivedPendingPrice } from './derive-pending-price.js';

export class ListTracesDbUseCase implements ListTracesUseCase {
  private readonly traceQueryRepository: TraceQueryRepository;
  private readonly priceVersionRepository: PriceVersionRepository;

  constructor(args: {
    traceQueryRepository: TraceQueryRepository;
    priceVersionRepository: PriceVersionRepository;
  }) {
    this.traceQueryRepository = args.traceQueryRepository;
    this.priceVersionRepository = args.priceVersionRepository;
  }

  async list(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>> {
    const page = await this.traceQueryRepository.findTraces(
      filters,
      pagination,
    );

    return {
      ...page,
      items: await withDerivedPendingPrice(
        page.items,
        this.priceVersionRepository,
      ),
    };
  }
}
