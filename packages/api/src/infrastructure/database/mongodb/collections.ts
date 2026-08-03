/**
 * Collection names, stated once. A leaf module on purpose: repositories,
 * migrations and pipelines all import their collection names from here, so
 * no repository ever needs to import another repository just for a name
 * (the old trace↔counter lazy-import cycle).
 */
export const TRACES_COLLECTION = 'traces';

export const TRACE_FILTER_COUNTERS_COLLECTION = 'trace_filter_counters';

export const SESSION_SUMMARIES_COLLECTION = 'session_summaries';
