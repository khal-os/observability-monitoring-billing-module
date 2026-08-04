import { TOKEN_TYPES, TokenType } from '../../../domain/models/price-version-model.js';
import { StampedTokenCost, TokenCounts } from '../../../domain/models/trace-model.js';
import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { costMicrocents, sumMicrocents } from '../../../common/helpers/money/money.js';

export type StampOutcome =
  | {
      pricingStatus: 'stamped';
      stampedCosts: StampedTokenCost[];
      totalCostMicrocents: number;
    }
  | {
      pricingStatus: 'pending_price';
      missingPriceTokenTypes: TokenType[];
    }
  | {
      /** Model present, zero measured tokens — see PricingStatus (decision 128). */
      pricingStatus: 'no_measured_usage';
    };

/**
 * The honesty half of the stamping rule, pure and shared: which token
 * types actually USED (count > 0) lack an effective price. The WRITE path
 * (stampTokens) uses it to decide pending_price; the READ path derives
 * the always-current "sem preço para: ..." list from it — one rule, one
 * source of truth, so display and billing can never disagree.
 */
export const findMissingPriceTokenTypes = (
  tokens: TokenCounts,
  effectivePrices: EffectivePrices,
): TokenType[] =>
  TOKEN_TYPES.filter((tokenType) => (tokens[tokenType] ?? 0) > 0).filter(
    (tokenType) => !effectivePrices[tokenType],
  );

/**
 * The stamping rule (T5), pure and deterministic — reproducible to the
 * cent. Every token type actually USED (count > 0) needs an effective
 * price; if ANY is missing the whole trace is pending_price: tokens kept,
 * cost open, NEVER partially stamped and NEVER valued at R$ 0 (invariant 2).
 *
 * `hasModel` is the decision-128 gate: the trace's model is DERIVED from
 * its LLM spans, so model-present + zero-tokens-everywhere means an LLM
 * ran and reported no usage — cost unknown, not zero → 'no_measured_usage'.
 * No model + no tokens is tool-only work: honestly R$ 0,00, stamped.
 */
export const stampTokens = (
  tokens: TokenCounts,
  effectivePrices: EffectivePrices,
  hasModel: boolean,
): StampOutcome => {
  const usedTokenTypes = TOKEN_TYPES.filter(
    (tokenType) => (tokens[tokenType] ?? 0) > 0,
  );

  if (hasModel && usedTokenTypes.length === 0) {
    return { pricingStatus: 'no_measured_usage' };
  }

  const missingPriceTokenTypes = findMissingPriceTokenTypes(
    tokens,
    effectivePrices,
  );

  if (missingPriceTokenTypes.length > 0) {
    return { pricingStatus: 'pending_price', missingPriceTokenTypes };
  }

  // flatMap so the missing-price case needs no non-null assertion — it is
  // unreachable here (any missing price returned pending_price above).
  const stampedCosts: StampedTokenCost[] = usedTokenTypes.flatMap((tokenType) => {
    const tokenCount = tokens[tokenType] as number;
    const price = effectivePrices[tokenType];

    if (!price) return [];

    return [
      {
        tokenType,
        tokens: tokenCount,
        appliedPriceMicrocentsPerMillion: price.priceMicrocentsPerMillion,
        appliedPriceEffectiveFrom: price.effectiveFrom,
        costMicrocents: costMicrocents(
          tokenCount,
          price.priceMicrocentsPerMillion,
        ),
      },
    ];
  });

  return {
    pricingStatus: 'stamped',
    stampedCosts,
    totalCostMicrocents: sumMicrocents(
      stampedCosts.map((cost) => cost.costMicrocents),
    ),
  };
};
