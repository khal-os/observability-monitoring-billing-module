import {
  BillingProjection,
  BillingQueryRepository,
  GetBillingProjectionUseCase,
  PROJECTION_MIN_COMPLETE_DAYS,
} from './billing-series-protocols.js';
import { clientUtcOffsetMs } from '@observability/core/common/helpers/clock/client-clock.js';
import { monthWindow } from '@observability/core/domain/models/billing-period-model.js';

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
    // Decision 130: "today" and "this month" are CLIENT-calendar facts —
    // a UTC read gives a UTC-3 client a projection that flips to the new
    // day/month three hours early.
    const local = new Date(now.getTime() + clientUtcOffsetMs(now));
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() + 1;
    const { start, end } = monthWindow(year, month);

    // Complete days: the client's yesterday is the last COMPLETE day;
    // today is always partial, so it never dilutes nor inflates the rate.
    const completeDays = local.getUTCDate() - 1;
    const daysInMonth = Math.round(
      (end.getTime() - start.getTime()) / 86_400_000,
    );

    // The numerator covers complete days ONLY — up to the instant the
    // client's TODAY began (client midnight as a UTC instant): "o que os
    // dias completos custaram, dividido pelos dias completos, vezes os
    // dias do mês".
    const startOfToday = new Date(
      Date.UTC(year, month - 1, local.getUTCDate()) - clientUtcOffsetMs(now),
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
