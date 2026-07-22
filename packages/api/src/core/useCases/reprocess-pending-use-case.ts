export interface ReprocessReport {
  examined: number;
  stamped: number;
  stillPending: number;
}

export interface ReprocessPendingUseCase {
  reprocess(): Promise<ReprocessReport>;
}
