import { SessionSummaryModel } from '../models/session-model.js';
import { TraceModel } from '../models/trace-model.js';

export interface SessionDetail {
  summary: SessionSummaryModel;
  /**
   * Chronological chain — out-of-order arrivals reorder naturally (T11).
   * Each trace carries its own input/output so the session reads as a
   * transcript (US22); spans are projected out of this read (detail-only).
   */
  chain: TraceModel[];
  /**
   * True when the chain was cut at the read bound (decision 79) — a
   * runaway session would otherwise assemble an unbounded transcript in
   * memory. Truncation is never silent: the flag reaches the client.
   */
  chainTruncated: boolean;
}

export interface GetSessionDetailUseCase {
  get(sessionId: string): Promise<SessionDetail | null>;
}
