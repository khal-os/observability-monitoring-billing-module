/**
 * US12/T8: end-of-month projection for the CURRENT month only. Documented
 * linear run-rate: accrued ÷ complete UTC days × days in the month. A
 * derived estimate — never persisted, never in a snapshot, gone the moment
 * the month closes (the use case answers null for any non-current month).
 */
export interface BillingProjection {
  year: number;
  month: number;
  accruedCostMicrocents: number;
  completeDays: number;
  daysInMonth: number;
  /** Null while completeDays < MIN_COMPLETE_DAYS (insufficient data). */
  projectedCostMicrocents: number | null;
  insufficientData: boolean;
}

/** Fewer complete days than this → 'dados insuficientes' (US12 criterion). */
export const PROJECTION_MIN_COMPLETE_DAYS = 3;

export interface GetBillingProjectionUseCase {
  /** The current UTC month's projection. */
  get(): Promise<BillingProjection>;
}
