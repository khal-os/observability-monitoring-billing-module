import { PriceVersionRepository } from './price-version-repository.js';
import { DuplicatePriceVersionError } from '../../domain/errors/duplicate-price-version-error.js';
import { PriceVersionModel } from '../../domain/models/price-version-model.js';
import { brlToMicrocents } from '../../common/helpers/money/money.js';

/**
 * ADAPTER-AGNOSTIC contract suite for PriceVersionRepository: the as-of
 * lookup rule (T4 — deterministic for any date) and version immutability
 * (duplicates MUST reject with the typed DuplicatePriceVersionError, never
 * raw driver errors). The harness's reset() must leave the uniqueness
 * constraint on (model, tokenType, effectiveFrom) in place — that
 * constraint IS part of the contract.
 */
export interface PriceVersionRepositoryHarness {
  repository: PriceVersionRepository;
  reset(): Promise<void>;
}

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');
const JUNE_15 = new Date('2026-06-15T00:00:00.000Z');

const makeVersion = (
  overrides: Partial<PriceVersionModel> = {},
): PriceVersionModel => ({
  model: 'openai/gpt-5-mini',
  tokenType: 'input',
  priceMicrocentsPerMillion: brlToMicrocents('2.75'),
  effectiveFrom: JUNE_1,
  ...overrides,
});

export const runPriceVersionRepositoryContract = (
  makeHarness: () => PriceVersionRepositoryHarness,
): void => {
  describe('PriceVersionRepository contract', () => {
    let harness: PriceVersionRepositoryHarness;

    beforeEach(async () => {
      harness = makeHarness();
      await harness.reset();
    });

    describe('findEffectivePrices()', () => {
      it('MUST return the latest version effective on or before the date, per token type', async () => {
        await harness.repository.insertVersion(makeVersion());
        await harness.repository.insertVersion(
          makeVersion({
            priceMicrocentsPerMillion: brlToMicrocents('3.10'),
            effectiveFrom: JUNE_15,
          }),
        );
        await harness.repository.insertVersion(
          makeVersion({
            tokenType: 'output',
            priceMicrocentsPerMillion: brlToMicrocents('11.00'),
          }),
        );

        const midPeriod = await harness.repository.findEffectivePrices(
          'openai/gpt-5-mini',
          new Date('2026-06-10T12:00:00.000Z'),
        );

        expect(midPeriod.input?.priceMicrocentsPerMillion).toBe(
          brlToMicrocents('2.75'),
        );
        expect(midPeriod.output?.priceMicrocentsPerMillion).toBe(
          brlToMicrocents('11.00'),
        );

        const afterChange = await harness.repository.findEffectivePrices(
          'openai/gpt-5-mini',
          new Date('2026-06-20T00:00:00.000Z'),
        );

        expect(afterChange.input?.priceMicrocentsPerMillion).toBe(
          brlToMicrocents('3.10'),
        );
      });

      it('MUST include a version whose effectiveFrom is exactly the lookup date', async () => {
        await harness.repository.insertVersion(makeVersion());
        await harness.repository.insertVersion(
          makeVersion({
            priceMicrocentsPerMillion: brlToMicrocents('3.10'),
            effectiveFrom: JUNE_15,
          }),
        );

        const atBoundary = await harness.repository.findEffectivePrices(
          'openai/gpt-5-mini',
          JUNE_15,
        );

        expect(atBoundary.input?.priceMicrocentsPerMillion).toBe(
          brlToMicrocents('3.10'),
        );
      });

      it('MUST omit token types with no version effective yet', async () => {
        await harness.repository.insertVersion(
          makeVersion({ effectiveFrom: JUNE_15 }),
        );

        const beforeFirstVersion = await harness.repository.findEffectivePrices(
          'openai/gpt-5-mini',
          new Date('2026-06-10T00:00:00.000Z'),
        );

        expect(beforeFirstVersion.input).toBeUndefined();
        expect(beforeFirstVersion.output).toBeUndefined();
      });

      it('MUST NOT mix prices across models', async () => {
        await harness.repository.insertVersion(makeVersion());
        await harness.repository.insertVersion(
          makeVersion({
            model: 'anthropic/claude-sonnet-5',
            priceMicrocentsPerMillion: brlToMicrocents('16.50'),
          }),
        );

        const prices = await harness.repository.findEffectivePrices(
          'anthropic/claude-sonnet-5',
          new Date('2026-06-10T00:00:00.000Z'),
        );

        expect(prices.input?.priceMicrocentsPerMillion).toBe(
          brlToMicrocents('16.50'),
        );
      });
    });

    describe('insertVersion()', () => {
      it('MUST reject a duplicate (model, tokenType, effectiveFrom) with the TYPED error — versions are immutable', async () => {
        await harness.repository.insertVersion(makeVersion());

        await expect(
          harness.repository.insertVersion(
            makeVersion({
              priceMicrocentsPerMillion: brlToMicrocents('9.99'),
            }),
          ),
        ).rejects.toThrow(DuplicatePriceVersionError);
      });
    });
  });
};
