import {
  ListTracesUseCase,
  Paginated,
  Pagination,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';
import { TraceModel } from '../../../domain/models/trace-model.js';

export class ListTracesDbUseCase implements ListTracesUseCase {
  private readonly traceQueryRepository: TraceQueryRepository;

  constructor(args: { traceQueryRepository: TraceQueryRepository }) {
    this.traceQueryRepository = args.traceQueryRepository;
  }

  async list(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>> {
    return this.traceQueryRepository.findTraces(filters, pagination);
  }
}
