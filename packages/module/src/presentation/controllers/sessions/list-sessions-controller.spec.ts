import { ListSessionsController } from './list-sessions-controller.js';
import {
  ListSessionsUseCase,
  Paginated,
  Pagination,
  SessionListFilters,
} from './sessions-protocols.js';
import { SessionSummaryModel } from '@observability/core/domain/models/session-model.js';
import { InvalidParamError } from '../../errors/index.js';

const makeSession = (
  overrides: Partial<SessionSummaryModel> = {},
): SessionSummaryModel => ({
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento' },
  domain: 'varejo',
  traceCount: 3,
  status: 'ok',
  totalDurationMs: 13_000,
  tokens: { input: 4500, output: 1000 },
  stampedCostMicrocents: 2_359_500,
  pendingPriceCount: 0,
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  lastActivityAt: new Date('2026-06-05T14:03:02.000Z'),
  ...overrides,
});

class ListSessionsStub implements ListSessionsUseCase {
  async list(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>> {
    return { items: [makeSession()], page: 1, pageSize: 20, total: 1, totalCapped: false };
  }
}

const makeSut = () => {
  const listSessionsStub = new ListSessionsStub();
  const sut = new ListSessionsController({ listSessions: listSessionsStub });

  return { sut, listSessionsStub };
};

describe('ListSessionsController', () => {
  it('MUST return 400 with the param name for an invalid filter', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ query: { to: 'nope' } });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('to'));
  });

  it('MUST return 400 with the param name for an unknown param (strict schema)', async () => {
    const { sut } = makeSut();

    // Typo'd param (agents ≠ agent) — silently ignoring it would return
    // an unfiltered list the caller believes is filtered.
    const httpResponse = await sut.handle({
      query: { agents: 'agent-atendimento' },
    });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('agents'));
  });

  it('MUST return 400 for a non-ISO date value that new Date() would accept', async () => {
    const { sut } = makeSut();

    // z.coerce.date() reads "5" as 2001-05-01 — only ISO shapes pass.
    const httpResponse = await sut.handle({ query: { from: '5' } });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('from'));
  });

  it('MUST return 400 on `from` for an inverted period (from > to)', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({
      query: { from: '2026-07-01', to: '2026-06-01' },
    });

    expect(httpResponse.statusCode).toBe(400);
    expect(httpResponse.body).toEqual(new InvalidParamError('from'));
  });

  it('MUST forward period/agent/status filters and pagination', async () => {
    const { sut, listSessionsStub } = makeSut();
    const listSpy = jest.spyOn(listSessionsStub, 'list');

    await sut.handle({
      query: {
        from: '2026-06-01',
        agent: 'agent-atendimento',
        status: 'error',
        page: '3',
        page_size: '5',
      },
    });

    expect(listSpy).toHaveBeenCalledWith(
      {
        from: new Date('2026-06-01'),
        to: undefined,
        agentId: 'agent-atendimento',
        status: 'error',
      },
      { page: 3, pageSize: 5 },
    );
  });

  it('MUST expose a fully-stamped session with cost_brl and no partial field', async () => {
    const { sut } = makeSut();

    const httpResponse = await sut.handle({ query: {} });
    const body = httpResponse.body as {
      items: {
        cost_brl: unknown;
        stamped_cost_brl_partial: unknown;
        pending_price_count: number;
      }[];
    };

    expect(httpResponse.statusCode).toBe(200);
    expect(body.items[0]?.cost_brl).toBe('0.02');
    expect(body.items[0]?.stamped_cost_brl_partial).toBeNull();
    expect(body.items[0]?.pending_price_count).toBe(0);
  });

  it('MUST NEVER value a session with pending traces at R$ — cost_brl null + partial exposed', async () => {
    const { sut, listSessionsStub } = makeSut();

    jest.spyOn(listSessionsStub, 'list').mockResolvedValueOnce({
      items: [
        makeSession({ pendingPriceCount: 2, stampedCostMicrocents: 0 }),
      ],
      page: 1,
      pageSize: 20,
      total: 1,
      totalCapped: false,
    });

    const httpResponse = await sut.handle({ query: {} });
    const body = httpResponse.body as {
      items: {
        cost_brl: unknown;
        stamped_cost_brl_partial: unknown;
        pending_price_count: number;
      }[];
    };

    expect(body.items[0]?.cost_brl).toBeNull();
    expect(body.items[0]?.stamped_cost_brl_partial).toBe('0.00');
    expect(body.items[0]?.pending_price_count).toBe(2);
  });
});
