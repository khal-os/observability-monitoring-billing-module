import { ListTraceFilterOptionsController } from './list-trace-filter-options-controller.js';
import {
  ListTraceFilterOptionsUseCase,
  TraceFilterOptions,
  TraceListFilters,
} from './traces-protocols.js';
import { InvalidParamError } from '../../errors/index.js';

const makeOptions = (): TraceFilterOptions => ({
  domains: ['financeiro', 'varejo'],
  subdomains: ['cobranca', 'loja-sp'],
  types: ['chat'],
  agents: ['agent-atendimento', 'agent-cobranca'],
  channels: ['web', 'whatsapp'],
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
