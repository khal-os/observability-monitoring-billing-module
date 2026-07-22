import {
  BillingMonthAggregate,
  BillingQueryRepository,
} from './billing-summary-protocols.js';
import {
  GetBillingSummaryDbUseCase,
  monthWindowUtc,
} from './get-billing-summary-db-use-case.js';

const makeAggregate = (): BillingMonthAggregate => ({
  lines: [
    {
      agentId: 'agent-atendimento',
      agentVersion: '1.4.2',
      model: 'openai/gpt-5-mini',
      tokenType: 'input',
      tokens: 6600,
      costMicrocents: 1_867_500,
    },
    {
      agentId: 'agent-cobranca',
      agentVersion: '2.0.1',
      model: 'anthropic/claude-sonnet-5',
      tokenType: 'output',
      tokens: 770,
      costMicrocents: 6_352_500,
    },
  ],
  pendingPrice: {
    traceCount: 2,
    tokens: { input: 6000, output: 1100 },
    models: ['meta/llama-4-scout'],
  },
});

class BillingQueryRepositoryStub implements BillingQueryRepository {
  async aggregateMonth(): Promise<BillingMonthAggregate> {
    return makeAggregate();
  }

  async listBills(): Promise<never[]> {
    return [];
  }
}

const makeSut = (now = new Date('2026-07-19T12:00:00.000Z')) => {
  const billingQueryRepositoryStub = new BillingQueryRepositoryStub();
  const sut = new GetBillingSummaryDbUseCase({
    billingQueryRepository: billingQueryRepositoryStub,
    now: () => now,
  });

  return { sut, billingQueryRepositoryStub };
};

describe('monthWindowUtc()', () => {
  it('MUST build the half-open UTC calendar month window', () => {
    expect(monthWindowUtc(2026, 6)).toEqual({
      start: new Date('2026-06-01T00:00:00.000Z'),
      end: new Date('2026-07-01T00:00:00.000Z'),
    });
    expect(monthWindowUtc(2026, 12).end).toEqual(
      new Date('2027-01-01T00:00:00.000Z'),
    );
  });

  it('MUST reject malformed periods', () => {
    expect(() => monthWindowUtc(2026, 13)).toThrow();
    expect(() => monthWindowUtc(2026, 0)).toThrow();
    expect(() => monthWindowUtc(2026.5, 6)).toThrow();
  });
});

describe('GetBillingSummaryDbUseCase', () => {
  it('MUST query the exact month window', async () => {
    const { sut, billingQueryRepositoryStub } = makeSut();
    const aggregateSpy = jest.spyOn(
      billingQueryRepositoryStub,
      'aggregateMonth',
    );

    await sut.get(2026, 6);

    expect(aggregateSpy).toHaveBeenCalledWith(
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-07-01T00:00:00.000Z'),
    );
  });

  it('MUST make the total the exact sum of the stamped lines (invariant 3)', async () => {
    const { sut } = makeSut();

    const summary = await sut.get(2026, 6);

    expect(summary.totalCostMicrocents).toBe(1_867_500 + 6_352_500);
    expect(summary.pendingPrice.traceCount).toBe(2);
  });

  it('MUST label the current month as in_progress and past months as open', async () => {
    const { sut } = makeSut(new Date('2026-07-19T12:00:00.000Z'));

    expect((await sut.get(2026, 7)).periodStatus).toBe('in_progress');
    expect((await sut.get(2026, 6)).periodStatus).toBe('open');
  });
});
