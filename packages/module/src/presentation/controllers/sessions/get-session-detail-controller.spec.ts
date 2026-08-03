import { GetSessionDetailController } from './get-session-detail-controller.js';
import {
  GetSessionDetailUseCase,
  SessionDetail,
} from './sessions-protocols.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';

const makeDetail = (): SessionDetail => ({
  summary: {
    sessionId: 'sess-001',
    agent: { id: 'agent-atendimento' },
    traceCount: 1,
    status: 'ok',
    totalDurationMs: 4000,
    tokens: { input: 1200, output: 350 },
    stampedCostMicrocents: 715_000,
    pendingPriceCount: 0,
    startedAt: new Date('2026-06-05T14:00:00.000Z'),
    lastActivityAt: new Date('2026-06-05T14:00:04.000Z'),
  },
  chain: [
    {
      traceId: 'trace-001',
      sessionId: 'sess-001',
      agent: { id: 'agent-atendimento' },
      model: { id: 'gpt-5-mini', provider: 'openai' },
      type: 'chat',
      channel: { type: 'whatsapp' },
      startedAt: new Date('2026-06-05T14:00:00.000Z'),
      finishedAt: new Date('2026-06-05T14:00:04.000Z'),
      durationMs: 4000,
      status: 'ok',
      tokens: { input: 1200, output: 350 },
      tokensTotal: 1550,
      pricingStatus: 'stamped',
      totalCostMicrocents: 715_000,
      ingestedAt: new Date('2026-07-01T00:00:00.000Z'),
      input: 'oi',
      output: 'olá',
      spans: [],
    },
  ],
  chainTruncated: false,
});

class GetSessionDetailStub implements GetSessionDetailUseCase {
  async get(sessionId: string): Promise<SessionDetail | null> {
    return makeDetail();
  }
}

const makeSut = () => {
  const getSessionDetailStub = new GetSessionDetailStub();
  const sut = new GetSessionDetailController({
    getSessionDetail: getSessionDetailStub,
  });

  return { sut, getSessionDetailStub };
};

describe('GetSessionDetailController', () => {
  it('MUST return 400 when no id param is provided', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ params: {} });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('id'));
  });

  it('MUST return 404 when the session does not exist', async () => {
    const { sut, getSessionDetailStub } = makeSut();

    jest.spyOn(getSessionDetailStub, 'get').mockResolvedValueOnce(null);

    const httpResponse = await sut.handle({ params: { id: 'missing' } });

    expect(httpResponse.statusCode).toBe(404);
    expect(httpResponse.body).toEqual(new NotFoundError('session missing'));
  });

  it('MUST return aggregates plus the chronological chain with content', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ params: { id: 'sess-001' } });
    const body = httpResponse.body as {
      session_id: string;
      cost_brl: string;
      chain: { trace_id: string; input: unknown; output: unknown; cost_brl: string }[];
    };

    expect(httpResponse.statusCode).toBe(200);
    expect(body.session_id).toBe('sess-001');
    expect(body.cost_brl).toBe('0.01');
    expect(body.chain).toHaveLength(1);
    expect(body.chain[0]?.trace_id).toBe('trace-001');
    expect(body.chain[0]?.input).toBe('oi');
    expect(body.chain[0]?.cost_brl).toBe('0.01');
  });
});
