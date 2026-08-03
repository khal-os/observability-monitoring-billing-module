import { ExecutionStatus, TokenCounts } from './trace-model.js';

/**
 * Spans are consumed ONLY by the trace detail view (product decision), so
 * they live EMBEDDED in the trace's content document — no own collection,
 * no parent FK needed.
 */
export interface SpanModel {
  spanId: string;
  /** Raw span type (llm, tool, retrieval, guardrail, ...) — raw names serve v1. */
  type: string;
  name: string;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  /**
   * Consolidated at ingestion (decision 51): offset from the TRACE's
   * startedAt, in ms. Clamped to >= 0 at ingestion (audit C-6.5): a
   * source span clock starting before the trace clock is clock skew, not
   * information — readers never see a negative offset and never recompute.
   */
  offsetMs: number;
  status: ExecutionStatus;
  errorMessage?: string;
  tokens?: TokenCounts;
  /** The span's own payload, when the source instrumented it (T1). */
  input?: unknown;
  output?: unknown;
}
