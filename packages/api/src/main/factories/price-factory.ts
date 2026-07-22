import { PriceVersionRepository } from '../../data/interfaces/price-version-repository.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';

export const makePriceVersionRepository = (): PriceVersionRepository =>
  new MongoDbPriceVersionRepository();
