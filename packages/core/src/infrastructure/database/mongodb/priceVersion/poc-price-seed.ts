import { Db } from 'mongodb';
import { PRICE_VERSIONS_COLLECTION } from './mongodb-price-version-repository.js';
import { PriceVersionModel } from '../../../../domain/models/price-version-model.js';
import { brlToMicrocents } from '../../../../common/helpers/money/money.js';

/**
 * PoC demo price seed (decision 74 — formerly migration 002): two priced
 * models and ONE price change mid-period (gpt-5-mini input/output on
 * 2026-06-15) so the demo can prove stamp immutability.
 * `meta/llama-4-scout` is deliberately NOT seeded — traces for it must land
 * as pending_price.
 *
 * DEV/TEST ONLY: consumed by the `seed-poc-prices` job (`make seed-prices`)
 * and the integration-test harnesses. Production price tables are maintained
 * exclusively via `make price` (invariant 9).
 */
const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');
const JUNE_15 = new Date('2026-06-15T00:00:00.000Z');

const version = (
  model: string,
  tokenType: PriceVersionModel['tokenType'],
  priceBrlPerMillion: string,
  effectiveFrom: Date,
): PriceVersionModel => ({
  model,
  tokenType,
  pricingType: 'fixed_brl',
  priceMicrocentsPerMillion: brlToMicrocents(priceBrlPerMillion),
  effectiveFrom,
});

export const POC_PRICE_VERSIONS: PriceVersionModel[] = [
  version('openai/gpt-5-mini', 'input', '2.75', JUNE_1),
  version('openai/gpt-5-mini', 'input', '3.10', JUNE_15),
  version('openai/gpt-5-mini', 'output', '11.00', JUNE_1),
  version('openai/gpt-5-mini', 'output', '12.40', JUNE_15),
  version('openai/gpt-5-mini', 'cache_read', '0.275', JUNE_1),
  version('openai/gpt-5-mini', 'cache_write', '3.4375', JUNE_1),
  version('anthropic/claude-sonnet-5', 'input', '16.50', JUNE_1),
  version('anthropic/claude-sonnet-5', 'output', '82.50', JUNE_1),
  version('anthropic/claude-sonnet-5', 'cache_read', '1.65', JUNE_1),
  version('anthropic/claude-sonnet-5', 'cache_write', '20.625', JUNE_1),
];

/**
 * Upsert on the natural key — idempotent: re-running changes nothing and
 * never touches versions inserted through the sanctioned `make price` path.
 * Returns how many versions were actually inserted.
 */
export const seedPocPrices = async (db: Db): Promise<number> => {
  const result = await db.collection(PRICE_VERSIONS_COLLECTION).bulkWrite(
    POC_PRICE_VERSIONS.map((priceVersion) => ({
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

  return result.upsertedCount;
};
