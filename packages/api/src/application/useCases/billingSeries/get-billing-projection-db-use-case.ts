import {
  BillingProjection,
  BillingQueryRepository,
  GetBillingProjectionUseCase,
  PROJECTION_MIN_COMPLETE_DAYS,
} from './billing-series-protocols.js';
import { monthWindowUtc } from '../billingSummary/get-billing-summary-db-use-case.js';

/**
 * US12/T8: documented linear run-rate for the CURRENT UTC month —
 * accrued ÷ complete days × days in the month, computed on integers
 * (BigInt, half-up). A derived ESTIMATE: never persisted, never in any
 * snapshot; it exists only in this response and disappears at close.
 */
export class GetBillingProjectionDbUseCase implements GetBillingProjectionUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.now = args.now ?? (() => new Date());
  }

  async get(): Promise<BillingProjection> {
    const now = this.now();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const { start, end } = monthWindowUtc(year, month);

    // Complete days: yesterday 23:59:59Z is the last COMPLETE day; today
    // is always partial, so it never dilutes nor inflates the rate.
    const completeDays = now.getUTCDate() - 1;
    const daysInMonth = Math.round(
      (end.getTime() - start.getTime()) / 86_400_000,
    );

    // The numerator covers complete days ONLY (start of today, UTC) — the
    // documented formula in words: "o que os dias completos custaram,
    // dividido pelos dias completos, vezes os dias do mês".
    const startOfToday = new Date(
      Date.UTC(year, month - 1, now.getUTCDate()),
    );
    const accruedCostMicrocents =
      await this.billingQueryRepository.accruedCostMicrocents(
        start,
        startOfToday,
      );

    const insufficientData = completeDays < PROJECTION_MIN_COMPLETE_DAYS;

    const projectedCostMicrocents = insufficientData
      ? null
      : Number(
          (BigInt(accruedCostMicrocents) * BigInt(daysInMonth) +
            BigInt(completeDays) / 2n) /
            BigInt(completeDays),
        );

    return {
      year,
      month,
      accruedCostMicrocents,
      completeDays,
      daysInMonth,
      projectedCostMicrocents,
      insufficientData,
    };
  }
}
