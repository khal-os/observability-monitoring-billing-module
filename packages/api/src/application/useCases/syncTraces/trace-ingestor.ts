import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { PriceVersionRepository } from '../../interfaces/price-version-repository.js';
import { TraceRepository } from '../../interfaces/trace-repository.js';
import { SourceTrace } from '../../interfaces/trace-source-client.js';
import { stampTokens } from './price-stamper.js';
import { mapToTrace } from './trace-mapper.js';

export interface IngestOutcome {
  outcome: 'inserted' | 'skipped';
  pendingPrice: boolean;
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
  },
  trace: SourceTrace,
): Promise<IngestOutcome> => {
  // QA19: the stamp uses the price version effective on the TRACE's
  // date (startedAt), resolved as-of at write time — not the price at
  // sync time. A trace dated 31/07 synced on 01/08 keeps July's price.
  const effectivePrices: EffectivePrices = trace.model
    ? await deps.priceVersionRepository.findEffectivePrices(
        trace.model,
        trace.startedAt,
      )
    : {};

  const stamp = stampTokens(trace.tokens, effectivePrices);
  const stampedTrace = mapToTrace(trace, stamp, new Date());

  const result = await deps.traceRepository.insertIfAbsent(stampedTrace);

  if (result === 'inserted') {
    return {
      outcome: 'inserted',
      pendingPrice: stamp.pricingStatus === 'pending_price',
    };
  }

  // Invariant 7: attribution (agent/metadata/model) stays mutable in
  // open periods — a re-synced trace refreshes attribution, never the
  // stamp. A pending trace whose model arrives here becomes stampable
  // by the reprocess job (as-of rule, // QA19 above).
  await deps.traceRepository.updateAttribution(trace.traceId, {
    agent: trace.agent,
    model: trace.model,
    domain: trace.domain,
    subdomain: trace.subdomain,
  });

  return { outcome: 'skipped', pendingPrice: false };
};
