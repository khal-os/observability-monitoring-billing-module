import {
  PriceVersionModel,
  TokenType,
} from '../../domain/models/price-version-model.js';

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

  /**
   * The registered price table, optionally filtered (audit D-3 / US4):
   * the pending_price diagnostic question is "which (model, token_type,
   * effective_from) rows exist?", and until this read the only answer was
   * mongosh into the archive — while GET /prices answered 405, asserting
   * a resource that exists is unreadable. Ordered for reading: model,
   * tokenType, effectiveFrom desc (newest version first).
   */
  listAllVersions(filter?: {
    model?: string;
    tokenType?: TokenType;
  }): Promise<PriceVersionModel[]>;
}
