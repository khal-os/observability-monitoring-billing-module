/**
 * Knobs of the opt-in billing-close scheduler (decision 131). The opt-in
 * itself is NOT an env var the process reads: the sidecar only exists when
 * the client env activates the `billing-auto-close` compose profile —
 * absent knob, absent container. Defaults resolve in the billing factory
 * (SCHEDULER_DEFAULTS), mirroring the connector's ingestion knobs.
 */
export interface BillingSchedulerEnvironmentVariables {
  /**
   * Minutes after the client-midnight month end before the first close
   * attempt (default 60). The store trails live by the ingestion quiet
   * period + poll interval (~16 min, decisions 60/61) — closing at
   * midnight sharp would quarantine the month's last minutes. Correctness
   * never depends on this delay (decision 100 adjudicates stragglers);
   * it only minimizes quarantine churn.
   */
  billingAutoCloseDelayMinutes?: number;
  /** Seconds between reconcile wakes of the scheduler loop (default 900). */
  billingAutoCloseCheckIntervalSeconds?: number;
}
