import { PriceVersionRepository } from '../../application/interfaces/price-version-repository.js';
import { MongoDbPriceVersionRepository } from '../../infrastructure/database/mongodb/priceVersion/mongodb-price-version-repository.js';
import { RegisterPriceVersionToDbUseCase } from '../../application/useCases/registerPriceVersion/register-price-version-use-case.js';
import { RegisterPriceVersionUseCase } from '../../domain/useCases/register-price-version-use-case.js';
import { RegisterPriceVersionController } from '../../presentation/controllers/prices/register-price-version-controller.js';
import { Controller } from '../../presentation/interfaces/index.js';
import { makeReprocessPendingUseCase } from './sync-factory.js';

export const makePriceVersionRepository = (): PriceVersionRepository =>
  new MongoDbPriceVersionRepository();

export const makeRegisterPriceVersionUseCase =
  (): RegisterPriceVersionUseCase =>
    new RegisterPriceVersionToDbUseCase({
      priceVersionRepository: makePriceVersionRepository(),
      reprocessPending: makeReprocessPendingUseCase(),
    });

export const makeRegisterPriceVersionController = (): Controller =>
  new RegisterPriceVersionController({
    registerPriceVersion: makeRegisterPriceVersionUseCase(),
  });
