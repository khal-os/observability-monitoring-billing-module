import { Migration } from '../helpers/migration-runner.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';
import { PriceVersionModel } from '../../../../domain/models/price-version-model.js';
import { brlToMicrocents } from '../../../../common/helpers/money/money.js';

/**
 * Seed (PoC): two priced models and ONE price change mid-period
 * (gpt-5-mini input/output on 2026-06-15) so the demo can prove stamp
 * immutability. `meta/llama-4-scout` is deliberately NOT seeded — traces
 * for it must land as pending_price.
 *
 * Internal columns (marketPriceUsd/ptaxReference/markupPercent) are seeded
 * on some versions to prove they never reach client-facing projections.
 */
const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');
const JUNE_15 = new Date('2026-06-15T00:00:00.000Z');

const version = (
  model: string,
  tokenType: PriceVersionModel['tokenType'],
  priceBrlPerMillion: string,
  effectiveFrom: Date,
  internal?: Pick<
    PriceVersionModel,
    'marketPriceUsd' | 'ptaxReference' | 'markupPercent'
  >,
): PriceVersionModel => ({
  model,
  tokenType,
  priceMicrocentsPerMillion: brlToMicrocents(priceBrlPerMillion),
  effectiveFrom,
  // Optional fields named explicitly → stored as null (storage convention).
  marketPriceUsd: internal?.marketPriceUsd,
  ptaxReference: internal?.ptaxReference,
  markupPercent: internal?.markupPercent,
});

export const seedPriceVersions: Migration = {
  id: '002-seed-price-versions',

  async run(db) {
    const versions: PriceVersionModel[] = [
      version('openai/gpt-5-mini', 'input', '2.75', JUNE_1),
      version('openai/gpt-5-mini', 'input', '3.10', JUNE_15),
      version('openai/gpt-5-mini', 'output', '11.00', JUNE_1),
      version('openai/gpt-5-mini', 'output', '12.40', JUNE_15),
      version('openai/gpt-5-mini', 'cache_read', '0.275', JUNE_1),
      version('openai/gpt-5-mini', 'cache_write', '3.4375', JUNE_1),
      version('anthropic/claude-sonnet-5', 'input', '16.50', JUNE_1, {
        marketPriceUsd: 3,
        ptaxReference: 5.5,
        markupPercent: 0,
      }),
      version('anthropic/claude-sonnet-5', 'output', '82.50', JUNE_1, {
        marketPriceUsd: 15,
        ptaxReference: 5.5,
        markupPercent: 0,
      }),
      version('anthropic/claude-sonnet-5', 'cache_read', '1.65', JUNE_1),
      version('anthropic/claude-sonnet-5', 'cache_write', '20.625', JUNE_1),
    ];

    // Upsert on the natural key: migrations must be idempotent because the
    // runner's run+record are two writes — a crash in between re-runs the
    // migration on the next `npm run migrate` (see migration-runner.ts).
    await db.collection(PRICE_VERSIONS_COLLECTION).bulkWrite(
      versions.map((priceVersion) => ({
        updateOne: {
          filter: {
            model: priceVersion.model,
            tokenType: priceVersion.tokenType,
            effectiveFrom: priceVersion.effectiveFrom,
          },
          update: { $setOnInsert: priceVersion },
          upsert: true,
        },
      })),
    );
  },
};
