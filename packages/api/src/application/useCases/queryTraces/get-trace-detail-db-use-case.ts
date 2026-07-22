import {
  GetTraceDetailUseCase,
  TraceQueryRepository,
} from './query-traces-protocols.js';
import { TraceModel } from '../../../domain/models/trace-model.js';

export class GetTraceDetailDbUseCase implements GetTraceDetailUseCase {
  private readonly traceQueryRepository: TraceQueryRepository;

  constructor(args: { traceQueryRepository: TraceQueryRepository }) {
    this.traceQueryRepository = args.traceQueryRepository;
  }

  async get(traceId: string): Promise<TraceModel | null> {
    return this.traceQueryRepository.findTraceDetail(traceId);
  }
}
