import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { PriceVersionRepository } from '../../interfaces/price-version-repository.js';
import { TraceRepository } from '../../interfaces/trace-repository.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { SourceTrace } from '../../interfaces/trace-source-client.js';
import { modelKey } from '../../../domain/models/model-ref.js';
import { stampTokens } from './price-stamper.js';
import { mapToTrace, sourceModelRef } from './trace-mapper.js';

export interface IngestOutcome {
  outcome: 'inserted' | 'skipped';
  pendingPrice: boolean;
  /** T6: the trace is dated inside a closed month — stored, flagged, not billed. */
  quarantined: boolean;
}

/**
 * THE single ingestion path for one source trace — extracted so the
 * windowed sync and the continuous batch sync share it verbatim (one
 * store, one truth: two syncs must never diverge on stamping rules).
 */
export const ingestSourceTrace = async (
  deps: {
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
  },
  trace: SourceTrace,
): Promise<IngestOutcome> => {
  // The domain carries the model as a structured ref; the price table
  // stays keyed by the canonical string, recomposed via modelKey.
  const model = sourceModelRef(trace);

  // QA19: the stamp uses the price version effective on the TRACE's
  // date (startedAt), resolved as-of at write time — not the price at
  // sync time. A trace dated 31/07 synced on 01/08 keeps July's price.
  const effectivePrices: EffectivePrices = model
    ? await deps.priceVersionRepository.findEffectivePrices(
        modelKey(model),
        trace.startedAt,
      )
    : {};

  const stamp = stampTokens(trace.tokens, effectivePrices);

  // T6: a trace dated inside an already-CLOSED month is stored anyway
  // (invariant 6 — the archive keeps everything) but quarantined: its
  // bill is frozen in the snapshot, so it enters flagged, never billed.
  const period = await deps.billingPeriodRepository.find(
    trace.startedAt.getUTCFullYear(),
    trace.startedAt.getUTCMonth() + 1,
  );
  const quarantined = period?.status === 'closed';

  const stampedTrace = {
    ...mapToTrace(trace, stamp, new Date()),
    billingQuarantine: quarantined
      ? { reason: 'period_closed' as const, quarantinedAt: new Date() }
      : null,
  };

  const result = await deps.traceRepository.insertIfAbsent(stampedTrace);

  if (result === 'inserted') {
    return {
      outcome: 'inserted',
      pendingPrice: stamp.pricingStatus === 'pending_price',
      quarantined,
    };
  }

  // Invariant 7: attribution (agent/metadata/model) stays mutable in OPEN
  // periods ONLY — a re-synced trace refreshes attribution, never the
  // stamp, and never anything inside a closed month (its bill is frozen;
  // corrections go through the audited reopen flow). A pending trace
  // whose model arrives here becomes stampable by the reprocess job
  // (as-of rule, // QA19 above).
  if (!quarantined) {
    await deps.traceRepository.updateAttribution(trace.traceId, {
      agent: trace.agent,
      model,
      domain: trace.domain,
      subdomain: trace.subdomain,
    });
  }

  return { outcome: 'skipped', pendingPrice: false, quarantined };
};
