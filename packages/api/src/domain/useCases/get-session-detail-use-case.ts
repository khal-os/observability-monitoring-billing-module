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
}

export interface GetSessionDetailUseCase {
  get(sessionId: string): Promise<SessionDetail | null>;
}
