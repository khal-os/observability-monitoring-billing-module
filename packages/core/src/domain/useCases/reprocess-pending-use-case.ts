export interface ReprocessReport {
  examined: number;
  /** Includes traces a concurrent reprocess stamped first — they ARE stamped. */
  stamped: number;
  stillPending: number;
  /** Per-trace errors — isolated so one bad trace never loses the run (decision 79). */
  failed: number;
  /**
   * Traces dated inside a CLOSED month (T6): stamping them is blocked —
   * only the audited reopen flow unblocks. Counted, never touched.
   */
  blockedClosedMonth: number;
  /**
   * Pending traces left AFTER this run (audit B-5): a capped run (the
   * POST /prices door) stamps one page and reports the honest remainder —
   * the worker's periodic sweep drains it (decision 57's backstop).
   */
  pendingRemaining: number;
}

export interface ReprocessPendingUseCase {
  /**
   * audit B-5: `maxTraces` caps one run — the HTTP price door passes it so
   * a day-sized backlog never rides one request; runbook + worker sweep
   * stay uncapped. The report's pendingRemaining is the honest remainder.
   */
  reprocess(options?: { maxTraces?: number }): Promise<ReprocessReport>;
}
