export interface TraceIngestionWorkerEnvironmentVariables {
  /**
   * LangWatch's OWN ClickHouse store (decision 59). When absent, the
   * ClickHouse source is disabled — the factory falls through to the HTTP
   * client (endpoint+key) or the fixture fake, and the worker idles.
   */
  langwatchClickhouseUrl?: string;
  langwatchClickhouseUser?: string;
  langwatchClickhousePassword?: string;
  langwatchClickhouseDatabase?: string;
  /** LangWatch project id — row filter when the instance hosts more than one project. */
  langwatchProjectId?: string;
  /** Seconds between catch-up cycles once caught up (default 60). */
  traceIngestionIntervalSeconds?: number;
  /** Max rows per batch — the loop's memory bound (default 1000). */
  traceIngestionBatchSize?: number;
  /** decision 61: seconds a trace must be quiet before syncing (default 900). */
  traceIngestionQuietPeriodSeconds?: number;
  /** Seconds between periodic reprocess sweeps in the worker (default 3600). */
  reprocessIntervalSeconds?: number;
}
