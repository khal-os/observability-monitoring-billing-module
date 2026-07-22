import { ListTracesController } from './list-traces-controller.js';
import {
  ListTracesUseCase,
  Paginated,
  Pagination,
  TraceListFilters,
} from './traces-protocols.js';
import { TraceModel } from '../../../core/models/trace-model.js';
import { InvalidParamError } from '../../errors/index.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-001',
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento', version: '1.4.2', instance: 'agent-atendimento-7d9f4b-k2xp8' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp', version: '3.2.0' },
  domain: 'varejo',
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 1200, output: 350 },
  tokensTotal: 1550,
  pricingStatus: 'stamped',
  totalCostMicrocents: 715_000,
  ingestedAt: new Date('2026-07-01T00:00:00.000Z'),
  input: 'entrada',
  output: 'saída',
  spans: [],
  ...overrides,
});

class ListTracesStub implements ListTracesUseCase {
  async list(
    filters: TraceListFilters,
    pagination: Pagination,
  ): Promise<Paginated<TraceModel>> {
    return { items: [makeTrace()], page: 1, pageSize: 20, total: 1 };
  }
}

const makeSut = () => {
  const listTracesStub = new ListTracesStub();
  const sut = new ListTracesController({ listTraces: listTracesStub });

  return { sut, listTracesStub };
};

describe('ListTracesController', () => {
  describe('Query validation', () => {
    it('MUST return 400 with the param name for an invalid date', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { from: 'not-a-date' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('from'));
    });

    it('MUST return 400 for an invalid pagination value', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: { page: '0' } });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('page'));
    });

    it('MUST return 400 for an unknown status value', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: { status: 'pending' } });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('status'));
    });
  });

  describe('Filter mapping', () => {
    it('MUST coerce and forward filters and pagination to the use case', async () => {
      const { sut, listTracesStub } = makeSut();
      const listSpy = jest.spyOn(listTracesStub, 'list');

      await sut.handle({
        query: {
          from: '2026-06-01',
          to: '2026-07-01',
          agent: 'agent-atendimento',
          status: 'ok',
          search: 'sess-001',
          page: '2',
          page_size: '10',
        },
      });

      expect(listSpy).toHaveBeenCalledWith(
        {
          from: new Date('2026-06-01'),
          to: new Date('2026-07-01'),
          agentId: 'agent-atendimento',
          status: 'ok',
          type: undefined,
          domain: undefined,
          subdomain: undefined,
          search: 'sess-001',
        },
        { page: 2, pageSize: 10 },
      );
    });

    it('MUST default pagination to page 1, size 20', async () => {
      const { sut, listTracesStub } = makeSut();
      const listSpy = jest.spyOn(listTracesStub, 'list');

      await sut.handle({ query: {} });

      expect(listSpy).toHaveBeenCalledWith(expect.anything(), {
        page: 1,
        pageSize: 20,
      });
    });
  });

  describe('Projection (invariant 4)', () => {
    it('MUST return whitelisted items with cost in R$ display rounding', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: {} });

      expect(httpResponse.statusCode).toBe(200);
      expect(httpResponse.body).toEqual({
        page: 1,
        page_size: 20,
        total: 1,
        total_pages: 1,
        items: [
          {
            trace_id: 'trace-001',
            session_id: 'sess-001',
            agent: {
              id: 'agent-atendimento',
              version: '1.4.2',
              instance: 'agent-atendimento-7d9f4b-k2xp8',
            },
            agent_label: 'agent-atendimento',
            domain: 'varejo',
            subdomain: null,
            scope_label: 'varejo',
            type: 'chat',
            channel: { type: 'whatsapp', version: '3.2.0', instance: null },
            status: 'ok',
            duration_ms: 4000,
            duration_display: '4 s',
            tokens_in: 1200,
            tokens_in_display: '1.200',
            tokens_out: 350,
            tokens_out_display: '350',
            tokens_total: 1550,
            tokens_total_display: '1.550',
            pricing_status: 'stamped',
            cost_brl: '0.01',
            cost_brl_display: 'R$ 0,01',
            started_at: '2026-06-05T14:00:00.000Z',
            // Fixed client timezone UTC-3 (decision 51).
            started_at_display: '05/06/2026, 11:00:00',
            // Relative to the REQUEST's clock — pinned only by shape.
            age_display: expect.any(String),
          },
        ],
      });
    });

    it('MUST expose pending_price traces with cost_brl null — never R$ 0.00', async () => {
      const { sut, listTracesStub } = makeSut();

      jest.spyOn(listTracesStub, 'list').mockResolvedValueOnce({
        items: [
          makeTrace({
            pricingStatus: 'pending_price',
            totalCostMicrocents: undefined,
            stampedCosts: undefined,
          }),
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });

      const httpResponse = await sut.handle({ query: {} });
      const body = httpResponse.body as { items: { cost_brl: unknown; pricing_status: string }[] };

      expect(body.items[0]?.cost_brl).toBeNull();
      expect(body.items[0]?.pricing_status).toBe('pending_price');
    });
  });
});
