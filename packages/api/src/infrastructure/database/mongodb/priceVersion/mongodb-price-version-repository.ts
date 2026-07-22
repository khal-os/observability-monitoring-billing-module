import {
  EffectivePrices,
  PriceVersionRepository,
} from '../../../../application/interfaces/price-version-repository.js';
import { DuplicatePriceVersionError } from '../../../../application/errors/duplicate-price-version-error.js';
import {
  PriceVersionModel,
  TokenType,
} from '../../../../domain/models/price-version-model.js';
import { MongoDb } from '../mongo-db.js';

export const PRICE_VERSIONS_COLLECTION = 'price_versions';

interface PriceVersionDocument {
  model: string;
  tokenType: TokenType;
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
  marketPriceUsd?: number;
  ptaxReference?: number;
  markupPercent?: number;
}

const toModel = (document: PriceVersionDocument): PriceVersionModel => ({
  model: document.model,
  tokenType: document.tokenType,
  priceMicrocentsPerMillion: document.priceMicrocentsPerMillion,
  effectiveFrom: document.effectiveFrom,
  marketPriceUsd: document.marketPriceUsd,
  ptaxReference: document.ptaxReference,
  markupPercent: document.markupPercent,
});

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
      effectivePrices[document._id] = toModel(document.latest);
    }

    return effectivePrices;
  }

  async insertVersion(version: PriceVersionModel): Promise<void> {
    const collection = MongoDb.getCollection(PRICE_VERSIONS_COLLECTION);

    try {
      // Optional fields stored as null (storage convention): every version
      // document shows the full schema, internal columns included.
      await collection.insertOne({
        model: version.model,
        tokenType: version.tokenType,
        priceMicrocentsPerMillion: version.priceMicrocentsPerMillion,
        effectiveFrom: version.effectiveFrom,
        marketPriceUsd: version.marketPriceUsd ?? null,
        ptaxReference: version.ptaxReference ?? null,
        markupPercent: version.markupPercent ?? null,
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
