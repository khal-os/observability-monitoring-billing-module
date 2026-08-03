import {
  PriceVersionRepository,
  ReprocessPendingUseCase,
  ReprocessReport,
  TraceRepository,
} from './reprocess-pending-protocols.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { modelKey } from '../../../domain/models/model-ref.js';
import { stampTokens } from '../priceStamping/price-stamper.js';
import {
  closedMonthKeys,
  monthKeyOf,
} from '../../../domain/models/month-key.js';

/**
 * US3/T5: when the missing price is finally registered, pending traces get
 * stamped — with the SAME rule as ingestion.
 *
 * T6 guard: a pending trace dated inside a CLOSED month is never stamped
 * here — its bill is frozen; only the audited reopen flow unblocks it.
 * Counted in the report (`blockedClosedMonth`) so the admin sees them.
 */
export class ReprocessPendingDbUseCase implements ReprocessPendingUseCase {
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;

  constructor(args: {
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
  }) {
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
  }

  async reprocess(): Promise<ReprocessReport> {
    const pendingTraces = await this.traceRepository.findPendingPrice();

    // re-audit 2026-08 (sync item 6): the SAME closed-month key rule as
    // ingestion, imported instead of re-derived — trace-ingestor already
    // called these shared, and two copies of a month key is exactly how
    // "stamped here but blocked there" divergence starts.
    const closedMonths = closedMonthKeys(
      await this.billingPeriodRepository.listAll(),
    );

    const report: ReprocessReport = {
      examined: pendingTraces.length,
      stamped: 0,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 0,
    };

    for (const trace of pendingTraces) {
      if (closedMonths.has(monthKeyOf(trace.startedAt))) {
        report.blockedClosedMonth += 1;
        continue;
      }

      // Per-trace isolation (decision 79): one throwing trace must not
      // lose the whole run — the sweep is rerunnable and every other
      // trace's stamp is independent of this one.
      try {
        // QA19: same as-of rule as the sync — the price version effective
        // on the TRACE's date, never "the latest price now".
        const effectivePrices = trace.model
          ? await this.priceVersionRepository.findEffectivePrices(
              modelKey(trace.model),
              trace.startedAt,
            )
          : {};

        const stamp = stampTokens(trace.tokens, effectivePrices);

        if (stamp.pricingStatus === 'pending_price') {
          report.stillPending += 1;
          continue;
        }

        // A 'skipped' result means the trace moved between our read and
        // our write: either a concurrent reprocess stamped it (it IS
        // stamped — reporting still-pending would be false) or a
        // concurrent attribution correction changed the model (audit B-5:
        // the CAS is pinned to the model these prices were resolved for),
        // in which case the NEXT sweep re-reads fresh and settles it.
        await this.traceRepository.stampPendingTrace(
          trace.traceId,
          {
            stampedCosts: stamp.stampedCosts,
            totalCostMicrocents: stamp.totalCostMicrocents,
            stampedAt: new Date(),
          },
          trace.model ?? null,
        );

        report.stamped += 1;
      } catch (error) {
        report.failed += 1;
        console.warn(
          `Reprocess pending: trace ${trace.traceId} failed and was skipped: ${String(error)}`,
        );
      }
    }

    console.log(
      `Reprocess pending: examined ${report.examined}, stamped ${report.stamped}, ` +
        `still pending ${report.stillPending}, failed ${report.failed}, ` +
        `blocked (mês fechado) ${report.blockedClosedMonth}.`,
    );

    return report;
  }
}
