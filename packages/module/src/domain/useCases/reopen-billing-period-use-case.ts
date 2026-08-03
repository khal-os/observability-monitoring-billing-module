/**
 * T6: audited reopen of a closed month — runbook only in v1. The reason is
 * mandatory (it lands in the period's append-only audit trail and in the
 * statement's reopen note); every prior snapshot version is preserved and
 * the next close writes version + 1.
 */
export interface ReopenBillingPeriodResult {
  year: number;
  month: number;
  /** The version set aside — the next close writes version + 1. */
  previousSnapshotVersion: number;
}

export interface ReopenBillingPeriodUseCase {
  reopen(
    year: number,
    month: number,
    reason: string,
  ): Promise<ReopenBillingPeriodResult>;
}
