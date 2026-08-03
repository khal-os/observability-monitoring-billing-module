import { RegisterPriceVersionController } from './register-price-version-controller.js';
import {
  RegisterPriceVersionInput,
  RegisterPriceVersionUseCase,
  RegisteredPriceVersion,
} from './prices-protocols.js';
import {
  ConflictError,
  InvalidParamError,
  MissingParamError,
} from '../../errors/index.js';
import { DuplicatePriceVersionError } from '../../../domain/errors/duplicate-price-version-error.js';

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

class RegisterPriceVersionStub implements RegisterPriceVersionUseCase {
  lastInput: RegisterPriceVersionInput | undefined;

  async register(
    input: RegisterPriceVersionInput,
  ): Promise<RegisteredPriceVersion> {
    this.lastInput = input;

    return {
      model: 'openai/gpt-5-mini',
      tokenType: input.tokenType,
      priceMicrocentsPerMillion: input.priceMicrocentsPerMillion,
      effectiveFrom: input.effectiveFrom,
      reprocess: {
        examined: 2,
        stamped: 2,
        stillPending: 0,
        failed: 0,
        blockedClosedMonth: 0,
      },
    };
  }
}

const validBody = () => ({
  model: 'openai/gpt-5-mini',
  token_type: 'input',
  price_brl_per_million: '2.75',
  effective_from: '2026-06-01',
});

const makeSut = () => {
  const registerPriceVersionStub = new RegisterPriceVersionStub();
  const sut = new RegisterPriceVersionController({
    registerPriceVersion: registerPriceVersionStub,
  });

  return { sut, registerPriceVersionStub };
};

describe('RegisterPriceVersionController', () => {
  it('MUST return 400 with MissingParamError for each absent required field', async () => {
    const { sut } = makeSut();

    for (const field of [
      'model',
      'token_type',
      'price_brl_per_million',
      'effective_from',
    ] as const) {
      const body: Record<string, unknown> = { ...validBody() };

      delete body[field];

      const httpResponse = await sut.handle({ body });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new MissingParamError(field));
    }
  });

  it('MUST return 400 for malformed fields (money float, bad date, bad token type)', async () => {
    const { sut } = makeSut();

    const invalidCases: [string, unknown][] = [
      ['price_brl_per_million', 2.75], // money is a STRING, never a float
      ['price_brl_per_million', '2,75'],
      ['price_brl_per_million', '-1.00'],
      ['effective_from', '05/06/2026'],
      ['effective_from', '2026-02-30'],
      ['token_type', 'tokens'],
      ['model', ''],
    ];

    for (const [field, value] of invalidCases) {
      const httpResponse = await sut.handle({
        body: { ...validBody(), [field]: value },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError(field));
    }
  });

  it('MUST return 400 for a zero price — never a silent R$ 0,00 stamp (C-2, invariant 2)', async () => {
    const { sut } = makeSut();

    for (const zero of ['0', '0.0', '0.00000000']) {
      const httpResponse = await sut.handle({
        body: { ...validBody(), price_brl_per_million: zero },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(
        new InvalidParamError('price_brl_per_million'),
      );
    }
  });

  it('MUST return 400 for an overflowing price string (C-2 — bounded, never a 500)', async () => {
    const { sut } = makeSut();

    // Too many digits for the format; format-valid but beyond the safe µ¢
    // range — both are the CLIENT's problem, answered as 400.
    for (const price of ['999999999999', '99999999.99999999']) {
      const httpResponse = await sut.handle({
        body: { ...validBody(), price_brl_per_million: price },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(
        new InvalidParamError('price_brl_per_million'),
      );
    }
  });

  it('MUST accept the valid extremes of the bounded price format', async () => {
    const { sut } = makeSut();

    for (const price of ['89999999.99999999', '0.00000001', '1']) {
      const httpResponse = await sut.handle({
        body: { ...validBody(), price_brl_per_million: price },
      });

      expect(httpResponse.statusCode).toBe(201);
    }
  });

  it('MUST return 400 for unknown fields (strict contract — a typo never registers a wrong price)', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({
      body: { ...validBody(), efective_from: '2026-06-01' },
    });

    expect(httpResponse.statusCode).toBe(400);
  });

  it('MUST convert the decimal string to integer µ¢ at the border and return 201 with displays', async () => {
    const { sut, registerPriceVersionStub } = makeSut();

    const httpResponse = await sut.handle({ body: validBody() });

    expect(httpResponse.statusCode).toBe(201);
    expect(registerPriceVersionStub.lastInput).toEqual({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: JUNE_1,
    });
    expect(httpResponse.body).toEqual({
      model: 'openai/gpt-5-mini',
      token_type: 'input',
      price_brl_per_million: '2.75',
      price_display: 'R$ 2,75/M',
      effective_from: '2026-06-01T00:00:00.000Z',
      effective_from_display: '01/06/2026',
      reprocess: {
        examined: 2,
        stamped: 2,
        still_pending: 0,
        failed: 0,
        blocked_closed_month: 0,
      },
    });
  });

  it('MUST answer a duplicate version as 409 (invariant 9: versions are immutable)', async () => {
    const { sut, registerPriceVersionStub } = makeSut();
    const duplicate = new DuplicatePriceVersionError({
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      effectiveFrom: JUNE_1,
    });

    jest
      .spyOn(registerPriceVersionStub, 'register')
      .mockRejectedValueOnce(duplicate);

    const httpResponse = await sut.handle({ body: validBody() });

    expect(httpResponse.statusCode).toBe(409);
    expect(httpResponse.body).toEqual(new ConflictError(duplicate.message));
  });
});
