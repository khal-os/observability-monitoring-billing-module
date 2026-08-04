import {
  ListPriceVersionsFilter,
  ListPriceVersionsUseCase,
} from '@observability/core/domain/useCases/list-price-versions-use-case.js';
import { PriceVersionModel } from '@observability/core/domain/models/price-version-model.js';
import { PriceVersionRepository } from '@observability/core/application/interfaces/price-version-repository.js';

export class ListPriceVersionsDbUseCase implements ListPriceVersionsUseCase {
  private readonly priceVersionRepository: PriceVersionRepository;

  constructor(args: { priceVersionRepository: PriceVersionRepository }) {
    this.priceVersionRepository = args.priceVersionRepository;
  }

  async list(filter?: ListPriceVersionsFilter): Promise<PriceVersionModel[]> {
    return this.priceVersionRepository.listAllVersions(filter);
  }
}
