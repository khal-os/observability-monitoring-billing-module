import {
  EffectivePrices,
  PriceVersionRepository,
} from '../../../../application/interfaces/price-version-repository.js';
import { DuplicatePriceVersionError } from '../../../../domain/errors/duplicate-price-version-error.js';
import {
  PriceVersionModel,
  TokenType,
} from '../../../../domain/models/price-version-model.js';
import { MongoDb } from '../mongo-db.js';

export const PRICE_VERSIONS_COLLECTION = 'price_versions';

interface PriceVersionDocument {
  model: string;
  tokenType: TokenType;
  /** Absent on rows written before decision 96 — legacy means fixed_brl. */
  pricingType?: string;
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
}

const toModel = (document: PriceVersionDocument): PriceVersionModel => ({
  model: document.model,
  tokenType: document.tokenType,
  pricingType: 'fixed_brl',
  priceMicrocentsPerMillion: document.priceMicrocentsPerMillion,
  effectiveFrom: document.effectiveFrom,
});

/**
 * Price RESOLUTION dispatch (decision 96): only types this build can
 * resolve yield an effective price. 'fixed_brl' (and legacy rows with no
 * type) resolve by reading the declared value; a stored version of an
 * unknown/future type is treated as NO price — its traces go
 * pending_price instead of being costed by a rule we don't have.
 */
const isResolvable = (document: PriceVersionDocument): boolean =>
  document.pricingType === undefined || document.pricingType === 'fixed_brl';

export class MongoDbPriceVersionRepository implements PriceVersionRepository {
  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    const collection = MongoDb.getCollection(PRICE_VERSIONS_COLLECTION);

    const documents = (await collection
      .aggregate([
        { $match: { model, effectiveFrom: { $lte: atDate } } },
        { $sort: { effectiveFrom: -1 } },
        { $group: { _id: '$tokenType', latest: { $first: '$$ROOT' } } },
      ])
      .toArray()) as { _id: TokenType; latest: PriceVersionDocument }[];

    const effectivePrices: EffectivePrices = {};

    for (const document of documents) {
      if (!isResolvable(document.latest)) continue;

      effectivePrices[document._id] = toModel(document.latest);
    }

    return effectivePrices;
  }

  async insertVersion(version: PriceVersionModel): Promise<void> {
    const collection = MongoDb.getCollection(PRICE_VERSIONS_COLLECTION);

    try {
      await collection.insertOne({
        model: version.model,
        tokenType: version.tokenType,
        pricingType: version.pricingType,
        priceMicrocentsPerMillion: version.priceMicrocentsPerMillion,
        effectiveFrom: version.effectiveFrom,
      });
    } catch (error) {
      // E11000 on the unique (model, tokenType, effectiveFrom) index →
      // the contract's typed error; driver text never crosses the boundary.
      if (
        error instanceof Error &&
        (error as { code?: number }).code === 11000
      ) {
        throw new DuplicatePriceVersionError(version);
      }

      throw error;
    }
  }
}
