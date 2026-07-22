import { GetTraceDetailController } from './get-trace-detail-controller.js';
import { GetTraceDetailUseCase } from './traces-protocols.js';
import { TraceModel } from '../../../core/models/trace-model.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';

const makeDetail = (): TraceModel => ({
  traceId: 'trace-001',
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento', version: '1.4.2', instance: 'agent-atendimento-7d9f4b-k2xp8' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp', version: '3.2.0', instance: 'omni-wa-6b4c9f-r3zs5' },
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
    finishedAt: new Date('2026-06-05T14:00:04.000Z'),
    durationMs: 4000,
    status: 'ok',
    tokens: { input: 1200, output: 350 },
    tokensTotal: 1550,
    pricingStatus: 'stamped',
    stampedCosts: [
      {
        tokenType: 'input',
        tokens: 1200,
        appliedPriceMicrocentsPerMillion: 275_000_000,
        appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        costMicrocents: 330_000,
      },
    ],
    totalCostMicrocents: 330_000,
    stampedAt: new Date('2026-07-01T00:00:00.000Z'),
    ingestedAt: new Date('2026-07-01T00:00:00.000Z'),
  input: 'oi',
  output: 'olá',
  spans: [],
});

class GetTraceDetailStub implements GetTraceDetailUseCase {
  async get(traceId: string): Promise<TraceModel | null> {
    return makeDetail();
  }
}

const makeSut = () => {
  const getTraceDetailStub = new GetTraceDetailStub();
  const sut = new GetTraceDetailController({
    getTraceDetail: getTraceDetailStub,
  });

  return { sut, getTraceDetailStub };
};

describe('GetTraceDetailController', () => {
  it('MUST return 400 when no id param is provided', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ params: {} });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('id'));
  });

  it('MUST return 404 with honesty when the trace does not exist', async () => {
    const { sut, getTraceDetailStub } = makeSut();

    jest.spyOn(getTraceDetailStub, 'get').mockResolvedValueOnce(null);

    const httpResponse = await sut.handle({ params: { id: 'missing' } });

    expect(httpResponse.statusCode).toBe(404);
    expect(httpResponse.body).toEqual(new NotFoundError('trace missing'));
  });

  it('MUST return the full anatomy with the contracted price shown (R$ only)', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ params: { id: 'trace-001' } });
    const body = httpResponse.body as {
      costs: {
        token_type: string;
        applied_price_brl_per_million: string;
        cost_brl_exact: string;
      }[];
      content: { input: unknown };
    };

    expect(httpResponse.statusCode).toBe(200);
    expect(body.costs).toEqual([
      {
        token_type: 'input',
        tokens: 1200,
        tokens_display: '1.200',
        applied_price_brl_per_million: '2.75',
        applied_price_display: 'R$ 2,75/M',
        applied_price_effective_from: '2026-06-01T00:00:00.000Z',
        applied_price_effective_from_display: '01/06/2026',
        cost_brl_exact: '0.0033',
        cost_brl_exact_display: 'R$ 0,0033',
      },
    ]);
    expect(body.content.input).toBe('oi');
  });
});
