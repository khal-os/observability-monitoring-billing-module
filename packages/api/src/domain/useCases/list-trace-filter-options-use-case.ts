import { TraceListFilters } from './list-traces-use-case.js';

/**
 * Distinct stored values that populate the filter-bar dropdowns —
 * computed from the traces actually in the store, never hardcoded.
 */
export interface TraceFilterOptions {
  domains: string[];
  subdomains: string[];
  types: string[];
  /** Agent ids — the dropdown identity (decision 42). */
  agents: string[];
  /** Channel types (whatsapp/web/...). */
  channels: string[];
}

export interface ListTraceFilterOptionsUseCase {
  list(filters: TraceListFilters): Promise<TraceFilterOptions>;
}
