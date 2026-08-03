import { SessionListFilters } from './list-sessions-use-case.js';

/**
 * One dropdown option: a stored value and how many SESSIONS would match
 * it combined with the other fields' active filters — the same "what-if"
 * self-exclusion semantics as the traces dropdowns (decision 76/77),
 * counted over the materialized read-model (decision 80).
 */
export interface SessionFilterOption {
  value: string;
  count: number;
}

export interface SessionFilterOptions {
  /** Agent ids of each session's FIRST trace — the dropdown identity. */
  agents: SessionFilterOption[];
  /** Session statuses (error if ANY member trace failed). */
  statuses: SessionFilterOption[];
}

export interface ListSessionFilterOptionsUseCase {
  list(filters: SessionListFilters): Promise<SessionFilterOptions>;
}
