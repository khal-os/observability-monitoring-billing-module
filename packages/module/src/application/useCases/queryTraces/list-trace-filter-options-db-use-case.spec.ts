import { ListTraceFilterOptionsDbUseCase } from './list-trace-filter-options-db-use-case.js';
import {
  TraceFilterOptions,
  TraceListFilters,
  TraceQueryRepository,
} from './query-traces-protocols.js';

const makeOptions = (): TraceFilterOptions => ({
  domains: [{ value: 'varejo', count: 5 }],
  subdomains: [],
  types: [],
  agents: [],
  channels: [],
  statuses: [],
});

const makeRepositoryStub = () => {
  const calls: TraceListFilters[] = [];
  const stub: Pick<TraceQueryRepository, 'findFilterOptions'> = {
    findFilterOptions: async (filters) => {
      calls.push(filters);
      return makeOptions();
    },
  };

  return { stub: stub as TraceQueryRepository, calls };
};

describe('ListTraceFilterOptionsDbUseCase (TTL cache, decision 77)', () => {
  it('MUST serve repeated filter combos from cache within the TTL', async () => {
    const { stub, calls } = makeRepositoryStub();
    const sut = new ListTraceFilterOptionsDbUseCase({
      traceQueryRepository: stub,
      cacheTtlMs: 60_000,
    });

    const first = await sut.list({ domains: ['varejo'] });
    const second = await sut.list({ domains: ['varejo'] });

    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('MUST query the store for a different filter combo', async () => {
    const { stub, calls } = makeRepositoryStub();
    const sut = new ListTraceFilterOptionsDbUseCase({
      traceQueryRepository: stub,
      cacheTtlMs: 60_000,
    });

    await sut.list({ domains: ['varejo'] });
    await sut.list({ domains: ['suporte'] });

    expect(calls).toHaveLength(2);
  });

  it('MUST NOT cache when the TTL is disabled (default)', async () => {
    const { stub, calls } = makeRepositoryStub();
    const sut = new ListTraceFilterOptionsDbUseCase({
      traceQueryRepository: stub,
    });

    await sut.list({ domains: ['varejo'] });
    await sut.list({ domains: ['varejo'] });

    expect(calls).toHaveLength(2);
  });
});
