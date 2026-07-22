import {
  AgentRef,
  ChannelRef,
  ExecutionStatus,
  TokenCounts,
} from '../../domain/models/trace-model.js';

/**
 * VENDOR-NEUTRAL port for the trace source connector. This shape IS the
 * T1 metadata contract — business rules depend only on it and must never
 * know which observability vendor feeds the platform. Each vendor gets an
 * adapter under infrastructure/traceSource/<vendor>/ that maps its API
 * into this contract; swapping vendors is a new adapter plus composition-
 * root wiring, with zero changes to core/data/presentation.
 * (Enforced by architecture-boundaries.spec.ts.)
 */
export type { AgentRef, ChannelRef, ExecutionStatus, TokenCounts };

export interface SourceSpan {
  spanId: string;
  /** Raw span type (llm, tool, retrieval, guardrail, ...) — raw names are fine in v1. */
  type: string;
  name: string;
  startedAt: Date;
  finishedAt: Date;
  status: ExecutionStatus;
  errorMessage?: string;
  tokens?: TokenCounts;
  input?: unknown;
  output?: unknown;
}

export interface SourceTrace {
  traceId: string;
  /** Absent for traces outside any conversation — they never join /sessions. */
  sessionId?: string;
  /** Absent/invalid attribution metadata → stored as unclassified, never dropped (T3). */
  agent?: AgentRef;
  model?: string;
  /** Trace type (chat, workflow, ...). */
  type: string;
  /** Channel type + version/instance of the omni deployment that served it. */
  channel: ChannelRef;
  domain?: string;
  subdomain?: string;
  startedAt: Date;
  finishedAt: Date;
  status: ExecutionStatus;
  tokens: TokenCounts;
  input: unknown;
  output: unknown;
  spans: SourceSpan[];
}

export interface SyncWindow {
  /** Inclusive start. */
  from: Date;
  /** Exclusive end — half-open windows compose without overlap. */
  to: Date;
}

export interface TraceSourceClient {
  fetchTraces(window: SyncWindow): Promise<SourceTrace[]>;
}
