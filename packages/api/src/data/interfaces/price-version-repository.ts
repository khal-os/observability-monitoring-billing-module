import {
  PriceVersionModel,
  TokenType,
} from '../../core/models/price-version-model.js';

export type EffectivePrices = Partial<Record<TokenType, PriceVersionModel>>;

export interface PriceVersionRepository {
  /**
   * As-of lookup (T4): for each token type of `model`, the latest version
   * with effectiveFrom <= atDate. Deterministic for any date. Token types
   * with no effective version are absent from the result.
   */
  findEffectivePrices(model: string, atDate: Date): Promise<EffectivePrices>;

  /**
   * Insert-only: versions are immutable. A duplicate
   * (model, tokenType, effectiveFrom) MUST reject with
   * DuplicatePriceVersionError (adapters translate their driver's
   * unique-constraint violation into the typed error).
   */
  insertVersion(version: PriceVersionModel): Promise<void>;
}
