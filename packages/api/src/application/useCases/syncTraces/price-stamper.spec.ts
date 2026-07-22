import { stampTokens } from './price-stamper.js';
import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { PriceVersionModel, TokenType } from '../../../domain/models/price-version-model.js';

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

const makePrice = (
  tokenType: TokenType,
  priceMicrocentsPerMillion: number,
): PriceVersionModel => ({
  model: 'openai/gpt-5-mini',
  tokenType,
  priceMicrocentsPerMillion,
  effectiveFrom: JUNE_1,
});

const makePrices = (): EffectivePrices => ({
  input: makePrice('input', 275_000_000),
  output: makePrice('output', 1_100_000_000),
  cache_read: makePrice('cache_read', 27_500_000),
});

describe('stampTokens()', () => {
  describe('When every used token type has an effective price', () => {
    it('MUST stamp applied price and cost per token type, total = exact sum', () => {
      const outcome = stampTokens(
        { input: 1200, output: 350 },
        makePrices(),
      );

      expect(outcome.pricingStatus).toBe('stamped');

      if (outcome.pricingStatus !== 'stamped') return;

      expect(outcome.stampedCosts).toEqual([
        {
          tokenType: 'input',
          tokens: 1200,
          appliedPriceMicrocentsPerMillion: 275_000_000,
          appliedPriceEffectiveFrom: JUNE_1,
          costMicrocents: 330_000,
        },
        {
          tokenType: 'output',
          tokens: 350,
          appliedPriceMicrocentsPerMillion: 1_100_000_000,
          appliedPriceEffectiveFrom: JUNE_1,
          costMicrocents: 385_000,
        },
      ]);
      expect(outcome.totalCostMicrocents).toBe(715_000);
    });

    it('MUST ignore token types with zero or absent counts', () => {
      const outcome = stampTokens(
        { input: 100, output: 0, cache_read: undefined },
        makePrices(),
      );

      expect(outcome.pricingStatus).toBe('stamped');

      if (outcome.pricingStatus !== 'stamped') return;

      expect(outcome.stampedCosts.map((cost) => cost.tokenType)).toEqual([
        'input',
      ]);
    });
  });

  describe('When ANY used token type lacks an effective price', () => {
    it('MUST return pending_price with the missing types — never a partial stamp', () => {
      const outcome = stampTokens(
        { input: 100, cache_write: 50 },
        makePrices(),
      );

      expect(outcome).toEqual({
        pricingStatus: 'pending_price',
        missingPriceTokenTypes: ['cache_write'],
      });
    });

    it('MUST return pending_price when no price exists at all', () => {
      const outcome = stampTokens({ input: 5000, output: 800 }, {});

      expect(outcome).toEqual({
        pricingStatus: 'pending_price',
        missingPriceTokenTypes: ['input', 'output'],
      });
    });

    it('MUST NOT flag pending for an unpriced type that was not used', () => {
      const outcome = stampTokens({ input: 100, cache_write: 0 }, makePrices());

      expect(outcome.pricingStatus).toBe('stamped');
    });
  });
});
