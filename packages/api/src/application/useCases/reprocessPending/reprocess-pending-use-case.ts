import {
  PriceVersionRepository,
  ReprocessPendingUseCase,
  ReprocessReport,
  TraceRepository,
} from './reprocess-pending-protocols.js';
import { stampTokens } from '../syncTraces/price-stamper.js';

/**
 * US3/T5: when the missing price is finally registered, pending traces get
 * stamped — with the SAME rule as ingestion.
 *
 * T6 (out of PoC scope): once month close exists, stamping pending traces
 * of a CLOSED month must be blocked here (only the audited reopen flow may
 * do it). In the PoC every period is open.
 */
export class ReprocessPendingToDbUseCase implements ReprocessPendingUseCase {
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;

  constructor(args: {
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
  }) {
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
  }

  async reprocess(): Promise<ReprocessReport> {
    const pendingTraces = await this.traceRepository.findPendingPrice();

    const report: ReprocessReport = {
      examined: pendingTraces.length,
      stamped: 0,
      stillPending: 0,
    };

    for (const trace of pendingTraces) {
      // QA19: same as-of rule as the sync — the price version effective on
      // the TRACE's date, never "the latest price now".
      const effectivePrices = trace.model
        ? await this.priceVersionRepository.findEffectivePrices(
            trace.model,
            trace.startedAt,
          )
        : {};

      const stamp = stampTokens(trace.tokens, effectivePrices);

      if (stamp.pricingStatus === 'pending_price') {
        report.stillPending += 1;
        continue;
      }

      const result = await this.traceRepository.stampPendingTrace(
        trace.traceId,
        {
          stampedCosts: stamp.stampedCosts,
          totalCostMicrocents: stamp.totalCostMicrocents,
          stampedAt: new Date(),
        },
      );

      if (result === 'stamped') {
        report.stamped += 1;
      } else {
        report.stillPending += 1;
      }
    }

    console.log(
      `Reprocess pending: examined ${report.examined}, stamped ${report.stamped}, still pending ${report.stillPending}.`,
    );

    return report;
  }
}
