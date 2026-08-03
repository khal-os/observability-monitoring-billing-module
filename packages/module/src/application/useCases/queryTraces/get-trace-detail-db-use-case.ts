import {
  GetTraceDetailUseCase,
  PriceVersionRepository,
  TraceQueryRepository,
} from './query-traces-protocols.js';
import { TraceModel } from '../../../domain/models/trace-model.js';
import { withDerivedPendingPrice } from './derive-pending-price.js';

export class GetTraceDetailDbUseCase implements GetTraceDetailUseCase {
  private readonly traceQueryRepository: TraceQueryRepository;
  private readonly priceVersionRepository: PriceVersionRepository;

  constructor(args: {
    traceQueryRepository: TraceQueryRepository;
    priceVersionRepository: PriceVersionRepository;
  }) {
    this.traceQueryRepository = args.traceQueryRepository;
    this.priceVersionRepository = args.priceVersionRepository;
  }

  async get(traceId: string): Promise<TraceModel | null> {
    const trace = await this.traceQueryRepository.findTraceDetail(traceId);

    if (!trace) return null;

    const [derived] = await withDerivedPendingPrice(
      [trace],
      this.priceVersionRepository,
    );

    return derived ?? null;
  }
}
