import { ExecutionStatus, TraceModel } from './trace-model.js';

/**
 * One cell of the filter-facet cube (decision 77): how many traces share
 * this exact dimension tuple on this UTC day. A DERIVED read-model,
 * rebuildable from `traces` at any time (rebuild-filter-counters job) —
 * never a source of truth. Nulls are part of the tuple identity (a trace
 * without domain counts under domain: null).
 */
export interface FilterCounterDims {
  /** UTC midnight of the trace's startedAt. */
  day: Date;
  domain: string | null;
  subdomain: string | null;
  type: string;
  agentId: string | null;
  channelType: string;
  status: ExecutionStatus;
}

export interface FilterCounterModel extends FilterCounterDims {
  count: number;
}

export const utcDayOf = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

export const toFilterCounterDims = (trace: TraceModel): FilterCounterDims => ({
  day: utcDayOf(trace.startedAt),
  domain: trace.domain ?? null,
  subdomain: trace.subdomain ?? null,
  type: trace.type,
  agentId: trace.agent?.id ?? null,
  channelType: trace.channel.type,
  status: trace.status,
});
