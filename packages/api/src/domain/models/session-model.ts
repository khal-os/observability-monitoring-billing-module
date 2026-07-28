import { AgentRef, ExecutionStatus, TokenCounts } from './trace-model.js';

/**
 * Session = DERIVED read-model (T11): traces grouped by sessionId, computed
 * at read time — no materialized state. Aggregates close by construction:
 * cost is the exact sum of member traces' stamped costs (invariant 3).
 *
 * pendingPriceCount keeps invariant 2 honest at session level: a session
 * holding pending traces exposes a PARTIAL stamped sum plus the count —
 * pending traces are never silently valued at R$ 0 inside a total.
 */
export interface SessionSummaryModel {
  sessionId: string;
  /** Attribution of the session's FIRST trace (PoC rule). */
  agent?: AgentRef;
  /** End user of the session's FIRST trace (same PoC rule) — display only. */
  userId?: string;
  domain?: string;
  subdomain?: string;
  traceCount: number;
  /** 'error' if ANY member trace failed (T11). */
  status: ExecutionStatus;
  totalDurationMs: number;
  tokens: TokenCounts;
  /** Sum of STAMPED member costs only — partial while pendingPriceCount > 0. */
  stampedCostMicrocents: number;
  pendingPriceCount: number;
  /** First trace's start — the session's period anchor (QA17). */
  startedAt: Date;
  lastActivityAt: Date;
}
