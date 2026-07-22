export const TOKEN_TYPES = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/**
 * A versioned contracted price (T4). Versions are IMMUTABLE: a price change
 * is a new insert with a new effectiveFrom, never an update. The model list
 * is data, not code — a new model is just new rows.
 */
export interface PriceVersionModel {
  model: string;
  tokenType: TokenType;
  /** Integer micro-centavos (1e-8 R$) per million tokens. Never a float. */
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
  /**
   * Internal-only columns (T4): captured for future margin analysis, NEVER
   * part of any client-facing projection (CLAUDE.md invariant 4).
   */
  marketPriceUsd?: number;
  ptaxReference?: number;
  markupPercent?: number;
}
