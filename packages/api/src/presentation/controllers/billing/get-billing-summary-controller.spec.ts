import { GetBillingSummaryController } from './get-billing-summary-controller.js';
import {
  BillingSummary,
  GetBillingSummaryUseCase,
} from './billing-protocols.js';
import { InvalidParamError, MissingParamError } from '../../errors/index.js';
import { buildStatement } from '../../../application/useCases/billingStatement/statement-engine.js';
import { usageRecord } from '../../../application/useCases/billingStatement/billing-test-fakes.js';

/**
 * Two lines of 0.5 centavo each (500_000 µ¢): naive per-line rounding
 * would show 0.01 + 0.01 = 0.02 against a 0.01 total. The engine's
 * largest-remainder reconciliation fixes it — asserted through the wire.
 */
const makeSummary = (): BillingSummary => ({
  year: 2026,
  month: 6,
  periodStatus: 'open',
  statement: buildStatement([
    usageRecord({
      traceId: 't-a',
      agentId: 'agent-a',
      agentVersion: null,
      model: 'model-x',
      stampedCosts: [
        {
          tokenType: 'input',
          tokens: 100,
          appliedPriceMicrocentsPerMillion: 5_000_000_000,
          appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
          costMicrocents: 500_000,
        },
      ],
      totalCostMicrocents: 500_000,
    }),
    usageRecord({
      traceId: 't-b',
      agentId: 'agent-b',
      agentVersion: null,
      model: 'model-x',
      stampedCosts: [
        {
          tokenType: 'input',
          tokens: 100,
          appliedPriceMicrocentsPerMillion: 5_000_000_000,
          appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
          costMicrocents: 500_000,
        },
      ],
      totalCostMicrocents: 500_000,
    }),
  ]),
  pendingPrice: { traceCount: 0, tokens: {}, models: [] },
  ingestionWatermark: null,
  reopenNotes: [],
  quarantinedTraceCount: 0,
  comparison: null,
});

class GetBillingSummaryStub implements GetBillingSummaryUseCase {
  async get(_year: number, _month: number): Promise<BillingSummary> {
    return makeSummary();
  }
}

const makeSut = () => {
  const getBillingSummaryStub = new GetBillingSummaryStub();
  const sut = new GetBillingSummaryController({
    getBillingSummary: getBillingSummaryStub,
  });

  return { sut, getBillingSummaryStub };
};

describe('GetBillingSummaryController', () => {
  describe('Validation', () => {
    it('MUST return 400 when year is missing', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: { month: '6' } });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new MissingParamError('year'));
    });

    it('MUST return 400 when month is missing', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: { year: '2026' } });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new MissingParamError('month'));
    });

    it('MUST return 400 for an out-of-range month', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { year: '2026', month: '13' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('month'));
    });

    it('MUST return 400 for a non-numeric year', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { year: 'abc', month: '6' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('year'));
    });
  });

  describe('Display reconciliation (T5)', () => {
    it('MUST make displayed line values sum EXACTLY to the displayed total', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { year: '2026', month: '6' },
      });
      const body = httpResponse.body as {
        total_cost_brl: string;
        lines: { cost_brl_display: string; cost_brl_exact: string }[];
      };

      expect(httpResponse.statusCode).toBe(200);
      expect(body.total_cost_brl).toBe('0.01');
      expect(body.lines.map((line) => line.cost_brl_display)).toEqual([
        '0.01',
        '0.00',
      ]);
      expect(body.lines.map((line) => line.cost_brl_exact)).toEqual([
        '0.005',
        '0.005',
      ]);
    });

    it('carries the US8 unit price on every line', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { year: '2026', month: '6' },
      });
      const body = httpResponse.body as {
        lines: { unit_price_brl_per_million_display: string }[];
        agents: { percent_of_total_display: string }[];
      };

      expect(body.lines[0]?.unit_price_brl_per_million_display).toBe(
        'R$ 50,00 / M tokens',
      );
      // US7: shares reconcile to 100%.
      expect(body.agents.map((agent) => agent.percent_of_total_display)).toEqual(
        ['50%', '50%'],
      );
    });
  });
});
