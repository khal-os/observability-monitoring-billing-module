export const TOKEN_TYPES = [
  'input',
  'output',
  'cache_read',
  'cache_write',
] as const;

export type TokenType = (typeof TOKEN_TYPES)[number];

/**
 * How a version's R$ price is RESOLVED (decision 96). The application
 * dispatches price resolution on this discriminator — the seam where
 * future computed pricing plugs in without touching billing:
 *
 * - 'fixed_brl' (the only type today): the price IS the declared
 *   `priceMicrocentsPerMillion` — resolution is a read.
 * - future, e.g. 'usd_ptax_markup': the version would declare its inputs
 *   (USD price, markup) and resolution would compute R$ from the stored
 *   PTAX of the TRACE's date — a pure function over versioned data, so
 *   re-stamping stays reproducible. Each new type ships its own resolver
 *   and its own declared fields.
 *
 * Whatever the type, the resolved R$/M value is STAMPED on the trace at
 * ingestion (invariant 1) — everything downstream of the stamp (engine,
 * statements, snapshots) never knows how the price was derived. A stored
 * version with a type this build cannot resolve yields NO effective
 * price → traces go pending_price, never a guessed cost (invariant 2).
 */
export const PRICING_TYPES = ['fixed_brl'] as const;

export type PricingType = (typeof PRICING_TYPES)[number];

/**
 * A versioned contracted price (T4). Versions are IMMUTABLE: a price change
 * is a new insert with a new effectiveFrom, never an update. The model list
 * is data, not code — a new model is just new rows. Client-facing
 * projections only ever see the resolved R$ values (invariant 4).
 */
export interface PriceVersionModel {
  model: string;
  tokenType: TokenType;
  /** Resolution discriminator — see PricingType. */
  pricingType: PricingType;
  /** Integer micro-centavos (1e-8 R$) per million tokens. Never a float. */
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
}
