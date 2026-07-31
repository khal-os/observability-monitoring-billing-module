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
}

export interface ReprocessPendingUseCase {
  reprocess(): Promise<ReprocessReport>;
}
