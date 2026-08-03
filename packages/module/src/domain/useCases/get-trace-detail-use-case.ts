import { TraceModel } from '../models/trace-model.js';

/**
 * The whole anatomy of one execution (US19), served from OUR store —
 * self-contained, no source-connector dependency at display time. Since
 * the merge (decision 47) a trace document carries everything: metrics,
 * stamp, ordered spans and full payloads — the detail is a single read.
 */
export interface GetTraceDetailUseCase {
  get(traceId: string): Promise<TraceModel | null>;
}
