import {
  ListTraceFilterOptionsUseCase,
  TraceFilterOptions,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';

export class ListTraceFilterOptionsDbUseCase
  implements ListTraceFilterOptionsUseCase
{
  private readonly traceQueryRepository: TraceQueryRepository;

  constructor(args: { traceQueryRepository: TraceQueryRepository }) {
    this.traceQueryRepository = args.traceQueryRepository;
  }

  async list(filters: TraceListFilters): Promise<TraceFilterOptions> {
    return this.traceQueryRepository.findFilterOptions(filters);
  }
}
