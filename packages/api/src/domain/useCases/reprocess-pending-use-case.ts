export interface ReprocessReport {
  examined: number;
  /** Includes traces a concurrent reprocess stamped first — they ARE stamped. */
  stamped: number;
  stillPending: number;
  /** Per-trace errors — isolated so one bad trace never loses the run (decision 79). */
  failed: number;
}

export interface ReprocessPendingUseCase {
  reprocess(): Promise<ReprocessReport>;
}
