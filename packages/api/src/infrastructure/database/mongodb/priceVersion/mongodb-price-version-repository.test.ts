import { MongoDb } from '../mongo-db.js';
import {
  MIGRATIONS_COLLECTION,
  runMigrations,
} from '../helpers/migration-runner.js';
import { priceVersionIndexes } from '../migrations/001-price-version-indexes.js';
import {
  MongoDbPriceVersionRepository,
  PRICE_VERSIONS_COLLECTION,
} from './mongodb-price-version-repository.js';
import {
  runPriceVersionRepositoryContract,
  PriceVersionRepositoryHarness,
} from '../../../../application/interfaces/price-version-repository.contract.js';

/**
 * The Mongo adapter proves the SHARED PriceVersionRepository contract
 * (data/interfaces/price-version-repository.contract.ts). reset() re-runs
 * migration 001 so the uniqueness constraint — part of the contract — is
 * always in place.
 */
describe('MongoDbPriceVersionRepository', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  const makeHarness = (): PriceVersionRepositoryHarness => ({
    repository: new MongoDbPriceVersionRepository(),

    reset: async () => {
      await MongoDb.getCollection(PRICE_VERSIONS_COLLECTION).deleteMany({});
      await MongoDb.getCollection(MIGRATIONS_COLLECTION).deleteMany({});
      await runMigrations(MongoDb.getClient().db(), [priceVersionIndexes]);
    },
  });

  runPriceVersionRepositoryContract(makeHarness);
});
