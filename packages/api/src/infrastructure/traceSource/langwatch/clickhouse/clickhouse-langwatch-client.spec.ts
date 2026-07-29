import {
  ClickHouseLangWatchClient,
  EXPECTED_LANGWATCH_SCHEMA_VERSION,
  QueryFn,
} from './clickhouse-langwatch-client.js';

const T0 = new Date('2026-07-23T13:00:00.000Z').getTime();

const summaryRow = (traceId: string, updatedAtMs: number) => ({
  traceId,
  occurredAtMs: updatedAtMs - 5_000,
  updatedAtMs,
  attributes: { 'service.name': 'martino' },
  computedInput: 'oi',
  computedOutput: 'olá',
  totalDurationMs: 1000,
  containsError: false,
  errorMessage: null,
  promptTokens: 10,
  completionTokens: 5,
  rootSpanType: 'agent',
});

interface RecordedQuery {
  query: string;
  params: Record<string, unknown>;
}

const makeQueryStub = (results: unknown[][]) => {
  const calls: RecordedQuery[] = [];
  let call = 0;

  const queryFn: QueryFn = async (query, params) => {
    calls.push({ query, params });

    return results[call++] ?? [];
  };

  return { queryFn, calls };
};

const makeSut = (queryFn: QueryFn, tenantId?: string) =>
  new ClickHouseLangWatchClient({
    url: 'http://clickhouse:8123',
    username: 'default',
    password: 'langwatch',
    database: 'langwatch',
    tenantId,
    queryFn,
  });

describe('ClickHouseLangWatchClient', () => {
  describe('fetchBatch', () => {
    it('MUST page by (UpdatedAt, TraceId) cursor with the quiet-period ceiling', async () => {
      const { queryFn, calls } = makeQueryStub([
        [summaryRow('trace-a', T0), summaryRow('trace-b', T0)], // summaries
        [], // spans
      ]);
      const sut = makeSut(queryFn);

      const batch = await sut.fetchBatch({
        after: { updatedAt: new Date(T0 - 60_000), traceId: 'trace-z' },
        limit: 2,
        updatedBefore: new Date(T0 + 60_000),
      });

      expect(batch.scanned).toBe(2);
      expect(batch.traces.map((trace) => trace.traceId)).toEqual([
        'trace-a',
        'trace-b',
      ]);
      // Cursor = last raw row, tie-broken by traceId.
      expect(batch.nextCursor).toEqual({
        updatedAt: new Date(T0),
        traceId: 'trace-b',
      });

      expect(calls[0]?.query).toContain('(s.UpdatedAt, s.TraceId) >');
      expect(calls[0]?.params).toMatchObject({
        afterUpdatedAtMs: T0 - 60_000,
        afterTraceId: 'trace-z',
        updatedBeforeMs: T0 + 60_000,
        limit: 2,
      });
    });

    it('MUST start from the beginning when there is no cursor yet', async () => {
      const { queryFn, calls } = makeQueryStub([[], []]);
      const sut = makeSut(queryFn);

      const batch = await sut.fetchBatch({
        after: null,
        limit: 10,
        updatedBefore: new Date(T0),
      });

      expect(batch).toEqual({ traces: [], nextCursor: null, scanned: 0 });
      expect(calls[0]?.params).toMatchObject({
        afterUpdatedAtMs: 0,
        afterTraceId: '',
      });
    });

    it('MUST skip a poison row but still advance the cursor past it (decision 62)', async () => {
      const poison = { traceId: 'trace-poison', updatedAtMs: T0 + 2_000 };
      const { queryFn } = makeQueryStub([
        [summaryRow('trace-a', T0 + 1_000), poison],
        [],
      ]);
      const sut = makeSut(queryFn);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const batch = await sut.fetchBatch({
        after: null,
        limit: 2,
        updatedBefore: new Date(T0 + 60_000),
      });

      expect(batch.traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
      expect(batch.scanned).toBe(2); // poison counts as scanned
      expect(batch.nextCursor).toEqual({
        updatedAt: new Date(T0 + 2_000),
        traceId: 'trace-poison',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('trace-poison'),
      );

      warn.mockRestore();
    });

    it('MUST halt WITHOUT advancing when a whole non-trivial batch is poison — schema drift, not isolated bad rows (decision 79)', async () => {
      const poisonRows = Array.from({ length: 10 }, (_, index) => ({
        traceId: `trace-poison-${index}`,
        updatedAtMs: T0 + index,
      }));
      const { queryFn } = makeQueryStub([poisonRows]);
      const sut = makeSut(queryFn);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        sut.fetchBatch({
          after: null,
          limit: 10,
          updatedBefore: new Date(T0 + 60_000),
        }),
      ).rejects.toThrow(/schema drift/);

      warn.mockRestore();
    });

    it('MUST keep decision-62 skip-and-advance for an all-poison batch BELOW the breaker threshold', async () => {
      const poisonRows = [
        { traceId: 'trace-poison-a', updatedAtMs: T0 + 1 },
        { traceId: 'trace-poison-b', updatedAtMs: T0 + 2 },
      ];
      const { queryFn } = makeQueryStub([poisonRows]);
      const sut = makeSut(queryFn);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const batch = await sut.fetchBatch({
        after: null,
        limit: 2,
        updatedBefore: new Date(T0 + 60_000),
      });

      expect(batch.traces).toEqual([]);
      expect(batch.nextCursor).toEqual({
        updatedAt: new Date(T0 + 2),
        traceId: 'trace-poison-b',
      });

      warn.mockRestore();
    });

    it('MUST filter by tenant when a project id is configured', async () => {
      const { queryFn, calls } = makeQueryStub([[], []]);
      const sut = makeSut(queryFn, 'project_abc');

      await sut.fetchBatch({
        after: null,
        limit: 10,
        updatedBefore: new Date(T0),
      });

      expect(calls[0]?.query).toContain('s.TenantId = {tenantId:String}');
      expect(calls[0]?.params).toMatchObject({ tenantId: 'project_abc' });
    });
  });

  describe('fetchTraces (half-open window, CLI contract)', () => {
    it('MUST filter [from, to) on the trace start instant', async () => {
      const { queryFn, calls } = makeQueryStub([
        [summaryRow('trace-a', T0)],
        [],
      ]);
      const sut = makeSut(queryFn);

      const traces = await sut.fetchTraces({
        from: new Date(T0 - 10_000),
        to: new Date(T0 + 10_000),
      });

      expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
      expect(calls[0]?.query).toContain('s.OccurredAt >=');
      expect(calls[0]?.query).toContain('s.OccurredAt <');
      expect(calls[0]?.params).toMatchObject({
        fromMs: T0 - 10_000,
        toMs: T0 + 10_000,
      });
    });
  });

  describe('assertCompatibleSchema (the tripwire)', () => {
    it('MUST pass on the validated schema version', async () => {
      const { queryFn } = makeQueryStub([
        [{ version: EXPECTED_LANGWATCH_SCHEMA_VERSION }],
      ]);

      await expect(makeSut(queryFn).assertCompatibleSchema()).resolves
        .toBeUndefined();
    });

    it('MUST fail loudly on any other version — never sync unverified', async () => {
      const { queryFn } = makeQueryStub([[{ version: 99 }]]);

      await expect(makeSut(queryFn).assertCompatibleSchema()).rejects.toThrow(
        /schema version 99/,
      );
    });
  });
});
