/**
 * The collection names SHARED across modules — traces, the filter-counter
 * cube and session summaries. A leaf module on purpose: the repositories,
 * migrations and pipelines that share these three names import them from
 * here instead of from each other (the old trace↔counter lazy-import
 * cycle). Names used by a single repository (billing periods/snapshots,
 * price versions, ...) live next to that repository.
 */
export const TRACES_COLLECTION = 'traces';

export const TRACE_FILTER_COUNTERS_COLLECTION = 'trace_filter_counters';

export const SESSION_SUMMARIES_COLLECTION = 'session_summaries';
