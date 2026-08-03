import { TraceModel } from '@khal/core/domain/models/trace-model.js';
import { modelKey } from '@khal/core/domain/models/model-ref.js';
import { PriceVersionRepository } from '@khal/core/application/interfaces/price-version-repository.js';
import { findMissingPriceTokenTypes } from '@khal/core/application/useCases/priceStamping/price-stamper.js';

/**
 * Derives pendingPrice.missingTokenTypes AT READ TIME — the deliberate
 * exception to decision 51 (derived fields consolidated at write time):
 * every other derived field depends only on the immutable trace, but this
 * one depends on the MUTABLE price table, so any stored copy goes stale
 * the moment a price is registered. Deriving on read makes the
 * "sem preço para: ..." honesty always current, with the same as-of rule
 * as stamping (QA19: prices effective at the TRACE's date) and the same
 * pure rule as the write path (findMissingPriceTokenTypes).
 *
 * Stamped traces get pendingPrice cleared; whatever a legacy document
 * still stores is ignored and overwritten.
 */
export const withDerivedPendingPrice = async (
  traces: TraceModel[],
  priceVersionRepository: PriceVersionRepository,
): Promise<TraceModel[]> =>
  Promise.all(
    traces.map(async (trace) => {
      if (trace.pricingStatus !== 'pending_price') {
        return { ...trace, pendingPrice: undefined };
      }

      const effectivePrices = trace.model
        ? await priceVersionRepository.findEffectivePrices(
            modelKey(trace.model),
            trace.startedAt,
          )
        : {};

      return {
        ...trace,
        pendingPrice: {
          missingTokenTypes: findMissingPriceTokenTypes(
            trace.tokens,
            effectivePrices,
          ),
        },
      };
    }),
  );
