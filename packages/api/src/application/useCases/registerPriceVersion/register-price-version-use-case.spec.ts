import { RegisterPriceVersionToDbUseCase } from './register-price-version-use-case.js';
import {
  EffectivePrices,
  PriceVersionRepository,
  ReprocessPendingUseCase,
  ReprocessReport,
} from './register-price-version-protocols.js';
import { PriceVersionModel } from '../../../domain/models/price-version-model.js';
import { DuplicatePriceVersionError } from '../../../domain/errors/duplicate-price-version-error.js';

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

class PriceVersionRepositoryStub implements PriceVersionRepository {
  inserted: PriceVersionModel[] = [];

  async findEffectivePrices(): Promise<EffectivePrices> {
    return {};
  }

  async insertVersion(version: PriceVersionModel): Promise<void> {
    this.inserted.push(version);
  }
}

class ReprocessPendingStub implements ReprocessPendingUseCase {
  calls = 0;
  report: ReprocessReport = {
    examined: 3,
    stamped: 2,
    stillPending: 1,
    failed: 0,
  };

  async reprocess(): Promise<ReprocessReport> {
    this.calls += 1;

    return this.report;
  }
}

const makeSut = () => {
  const priceVersionRepository = new PriceVersionRepositoryStub();
  const reprocessPending = new ReprocessPendingStub();
  const sut = new RegisterPriceVersionToDbUseCase({
    priceVersionRepository,
    reprocessPending,
  });

  return { sut, priceVersionRepository, reprocessPending };
};

describe('RegisterPriceVersionToDbUseCase', () => {
  it('MUST store the CANONICAL model key — a bare id lands under provider/id (decision 82)', async () => {
    const { sut, priceVersionRepository } = makeSut();

    const registered = await sut.register({
      model: 'gemini-2.5-pro',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(priceVersionRepository.inserted[0]?.model).toBe(
      'google/gemini-2.5-pro',
    );
    expect(registered.model).toBe('google/gemini-2.5-pro');
  });

  it('MUST keep an already-canonical key unchanged (round-trip)', async () => {
    const { sut, priceVersionRepository } = makeSut();

    await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'output',
      priceMicrocentsPerMillion: 825_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(priceVersionRepository.inserted[0]?.model).toBe('openai/gpt-5-mini');
  });

  it('MUST reprocess pending traces IMMEDIATELY after the insert (decision 57) and report it', async () => {
    const { sut, reprocessPending } = makeSut();

    const registered = await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });

    expect(reprocessPending.calls).toBe(1);
    expect(registered.reprocess).toEqual({
      examined: 3,
      stamped: 2,
      stillPending: 1,
      failed: 0,
    });
  });

  it('MUST pass the internal margin columns through to the repository untouched', async () => {
    const { sut, priceVersionRepository } = makeSut();

    await sut.register({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
      marketPriceUsd: 0.15,
      ptaxReference: 5.43,
      markupPercent: 20,
    });

    expect(priceVersionRepository.inserted[0]).toMatchObject({
      marketPriceUsd: 0.15,
      ptaxReference: 5.43,
      markupPercent: 20,
    });
  });

  it('MUST propagate DuplicatePriceVersionError untouched and NOT reprocess', async () => {
    const { sut, priceVersionRepository, reprocessPending } = makeSut();

    jest
      .spyOn(priceVersionRepository, 'insertVersion')
      .mockRejectedValueOnce(
        new DuplicatePriceVersionError({
          model: 'openai/gpt-5-mini',
          tokenType: 'input',
          effectiveFrom: JUNE_1,
        }),
      );

    await expect(
      sut.register({
        model: 'openai/gpt-5-mini',
        tokenType: 'input',
        priceMicrocentsPerMillion: 275_000_000,
        effectiveFrom: JUNE_1,
      }),
    ).rejects.toBeInstanceOf(DuplicatePriceVersionError);

    expect(reprocessPending.calls).toBe(0);
  });
});
