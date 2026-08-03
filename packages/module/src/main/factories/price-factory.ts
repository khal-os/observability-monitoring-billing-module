import { PriceVersionRepository } from '@observability/core/application/interfaces/price-version-repository.js';
import { MongoDbPriceVersionRepository } from '@observability/core/infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { RegisterPriceVersionDbUseCase } from '../../application/useCases/registerPriceVersion/register-price-version-db-use-case.js';
import { RegisterPriceVersionUseCase } from '@observability/core/domain/useCases/register-price-version-use-case.js';
import { RegisterPriceVersionController } from '../../presentation/controllers/prices/register-price-version-controller.js';
import { Controller } from '../../presentation/interfaces/index.js';
import { makeReprocessPendingUseCase } from './reprocess-factory.js';

export const makePriceVersionRepository = (): PriceVersionRepository =>
  new MongoDbPriceVersionRepository();

export const makeRegisterPriceVersionUseCase =
  (): RegisterPriceVersionUseCase =>
    new RegisterPriceVersionDbUseCase({
      priceVersionRepository: makePriceVersionRepository(),
      reprocessPending: makeReprocessPendingUseCase(),
    });

export const makeRegisterPriceVersionController = (): Controller =>
  new RegisterPriceVersionController({
    registerPriceVersion: makeRegisterPriceVersionUseCase(),
  });
