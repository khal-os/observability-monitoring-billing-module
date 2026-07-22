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
   * startedAt, in ms. May be negative when the source's span clock starts
   * before the trace clock — readers clip, never recompute.
   */
  offsetMs: number;
  status: ExecutionStatus;
  errorMessage?: string;
  tokens?: TokenCounts;
  /** The span's own payload, when the source instrumented it (T1). */
  input?: unknown;
  output?: unknown;
}
