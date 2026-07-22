/**
 * Raised by PriceVersionRepository.insertVersion when a version already
 * exists for (model, tokenType, effectiveFrom) — versions are immutable
 * (invariant 9), changes are new inserts with a new effective-from.
 *
 * A TYPED error is part of the repository contract on purpose: consumers
 * must never detect uniqueness violations by sniffing driver error message
 * text (Mongo says "E11000 duplicate key", Postgres says "duplicate key
 * value violates unique constraint", ORMs say something else entirely).
 * Every adapter translates its driver's violation into this type.
 */
export class DuplicatePriceVersionError extends Error {
  constructor(args: { model: string; tokenType: string; effectiveFrom: Date }) {
    super(
      `A price version for (${args.model}, ${args.tokenType}, ${args.effectiveFrom.toISOString()}) already exists — versions are immutable, register a new effective-from instead.`,
    );
    this.name = 'DuplicatePriceVersionError';
  }
}
