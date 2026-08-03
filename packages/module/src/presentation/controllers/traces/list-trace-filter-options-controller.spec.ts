import { ListTraceFilterOptionsController } from './list-trace-filter-options-controller.js';
import {
  ListTraceFilterOptionsUseCase,
  TraceFilterOptions,
  TraceListFilters,
} from './traces-protocols.js';
import { InvalidParamError } from '../../errors/index.js';

const makeOptions = (): TraceFilterOptions => ({
  domains: [
    { value: 'financeiro', count: 2 },
    { value: 'varejo', count: 5 },
  ],
  subdomains: [
    { value: 'cobranca', count: 2 },
    { value: 'loja-sp', count: 4 },
  ],
  types: [{ value: 'chat', count: 9 }],
  agents: [
    { value: 'agent-atendimento', count: 5 },
    { value: 'agent-cobranca', count: 2 },
  ],
  channels: [
    { value: 'web', count: 3 },
    { value: 'whatsapp', count: 6 },
  ],
  statuses: [
    { value: 'error', count: 1 },
    { value: 'ok', count: 8 },
  ],
});

class ListTraceFilterOptionsStub implements ListTraceFilterOptionsUseCase {
  async list(filters: TraceListFilters): Promise<TraceFilterOptions> {
    return makeOptions();
  }
}

const makeSut = () => {
  const listTraceFilterOptionsStub = new ListTraceFilterOptionsStub();
  const sut = new ListTraceFilterOptionsController({
    listTraceFilterOptions: listTraceFilterOptionsStub,
  });

  return { sut, listTraceFilterOptionsStub };
};

describe('ListTraceFilterOptionsController', () => {
  describe('Query validation', () => {
    it('MUST return 400 with the param name for an invalid date', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { from: 'not-a-date' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('from'));
    });

    it('MUST return 400 with the param name for an unknown param (strict schema)', async () => {
      const { sut } = makeSut();

      // Typo'd param (agents ≠ agent) — silently ignoring it would return
      // counts the caller believes are filtered.
      const httpResponse = await sut.handle({
        query: { agents: 'agent-atendimento' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('agents'));
    });

    it('MUST return 400 on `from` for an inverted period (from > to)', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { from: '2026-07-01', to: '2026-06-01' },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('from'));
    });

    it('MUST return 400 for an empty value in a multi-value filter', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({
        query: { domain: ['varejo', ''] },
      });

      expect(httpResponse.statusCode).toBe(400);
      expect(httpResponse.body).toEqual(new InvalidParamError('domain'));
    });
  });

  describe('Filter mapping', () => {
    it('MUST forward the cascade filters to the use case', async () => {
      const { sut, listTraceFilterOptionsStub } = makeSut();
      const listSpy = jest.spyOn(listTraceFilterOptionsStub, 'list');

      await sut.handle({
        query: {
          from: '2026-06-01',
          agent: ['agent-a', 'agent-b'],
          status: 'error',
          domain: 'varejo',
        },
      });

      expect(listSpy).toHaveBeenCalledWith({
        from: new Date('2026-06-01'),
        to: undefined,
        agentIds: ['agent-a', 'agent-b'],
        status: 'error',
        types: undefined,
        channels: undefined,
        domains: ['varejo'],
        subdomains: undefined,
        search: undefined,
      });
    });
  });

  describe('Projection (invariant 4)', () => {
    it('MUST return exactly the whitelisted option lists', async () => {
      const { sut } = makeSut();

      const httpResponse = await sut.handle({ query: {} });

      expect(httpResponse.statusCode).toBe(200);
      expect(httpResponse.body).toEqual(makeOptions());
    });
  });
});
