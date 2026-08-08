import { PriceVersionModel, TokenType } from '../models/price-version-model.js';

/**
 * US4 / audit D-3: the READ side of the versioned price table. Prices are
 * versioned immutable data (invariant 9) an operator registers against a
 * contract — and the pending_price diagnostic question is "which (model,
 * token_type, effective_from) rows exist?". Until this use case the only
 * answer was mongosh into the archive, while GET /prices answered 405.
 */
export interface ListPriceVersionsFilter {
  model?: string;
  tokenType?: TokenType;
}

export interface ListPriceVersionsUseCase {
  list(filter?: ListPriceVersionsFilter): Promise<PriceVersionModel[]>;
}
