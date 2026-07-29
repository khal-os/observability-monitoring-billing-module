import { TraceListFilters } from './list-traces-use-case.js';

/**
 * One dropdown option: a stored value and how many traces would match it
 * COMBINED with the other fields' active filters ("what-if" semantics —
 * the option's own field is self-excluded, see TraceQueryRepository).
 */
export interface TraceFilterOption {
  value: string;
  count: number;
}

/**
 * Options that populate the filter-bar dropdowns — computed from the
 * traces actually in the store, never hardcoded.
 */
export interface TraceFilterOptions {
  domains: TraceFilterOption[];
  subdomains: TraceFilterOption[];
  types: TraceFilterOption[];
  /** Agent ids — the dropdown identity (decision 42). */
  agents: TraceFilterOption[];
  /** Channel types (whatsapp/web/...). */
  channels: TraceFilterOption[];
  /** Execution statuses (ok/error) present in the store. */
  statuses: TraceFilterOption[];
}

export interface ListTraceFilterOptionsUseCase {
  list(filters: TraceListFilters): Promise<TraceFilterOptions>;
}
