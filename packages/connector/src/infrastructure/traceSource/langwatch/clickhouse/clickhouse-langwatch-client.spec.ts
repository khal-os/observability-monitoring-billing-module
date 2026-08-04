import {
  ClickHouseLangWatchClient,
  EXPECTED_LANGWATCH_SCHEMA_VERSION,
  QueryFn,
  WINDOW_PAGE_SIZE,
} from './clickhouse-langwatch-client.js';
import {
  PoisonRowRecord,
  PoisonRowRepository,
} from '../../../../application/interfaces/poison-row-repository.js';
import { SourceTrace, SyncWindow } from '../../../../application/interfaces/trace-source-client.js';

const T0 = new Date('2026-07-23T13:00:00.000Z').getTime();
/** Source clock for the windowed paths — far past the quiet period. */
const SOURCE_NOW_MS = T0 + 7_200_000;
const QUIET_MS = 900_000; // DEFAULT_QUIET_PERIOD_MS

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

/**
 * An llm span carrying the `gen_ai.usage.*` counts the salvage rule reads
 * as the reconstruction of a corrupt summary count.
 */
const llmSpanRow = (
  traceId: string,
  usage: { input?: string; output?: string },
) => ({
  traceId,
  spanId: `${traceId}-llm`,
  parentSpanId: null,
  name: 'Claude.ainvoke',
  startedAtMs: T0,
  endedAtMs: T0 + 1_000,
  statusCode: 1,
  statusMessage: null,
  attributes: {
    'langwatch.span.type': 'llm',
    'gen_ai.response.model': 'claude-sonnet-5',
    ...(usage.input === undefined
      ? {}
      : { 'gen_ai.usage.input_tokens': usage.input }),
    ...(usage.output === undefined
      ? {}
      : { 'gen_ai.usage.output_tokens': usage.output }),
  },
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

class PoisonRowRepositoryStub implements PoisonRowRepository {
  records: PoisonRowRecord[] = [];

  async record(row: PoisonRowRecord): Promise<void> {
    this.records.push(row);
  }
}

const makeSut = (
  queryFn: QueryFn,
  tenantId?: string,
  poisonRowRepository?: PoisonRowRepository,
) =>
  new ClickHouseLangWatchClient({
    url: 'http://clickhouse:8123',
    username: 'default',
    password: 'langwatch',
    database: 'langwatch',
    tenantId,
    poisonRowRepository,
    queryFn,
  });

/** Drains the paged window contract (audit C-6.3). */
const fetchAll = async (
  sut: ClickHouseLangWatchClient,
  window: SyncWindow,
): Promise<SourceTrace[]> => {
  const traces: SourceTrace[] = [];

  for await (const page of sut.fetchTracesPaged(window)) {
    traces.push(...page);
  }

  return traces;
};

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

  describe('fetchTracesPaged (half-open window, CLI contract)', () => {
    const WINDOW = {
      from: new Date(T0 - 10_000),
      to: new Date(T0 + 10_000),
    };

    it('MUST filter [from, to) on the trace start instant WITH the update-axis quiet ceiling (audit B-4)', async () => {
      const { queryFn, calls } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }], // sourceNow (audit C-6.4)
        [summaryRow('trace-a', T0)],
        [], // spans
      ]);
      const sut = makeSut(queryFn);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
      expect(calls[1]?.query).toContain('s.OccurredAt >=');
      expect(calls[1]?.query).toContain('s.OccurredAt <');
      // B-4: the windowed SQL carries the UpdatedAt cutoff, anchored on
      // the SOURCE clock — in-flight traces defer instead of freezing
      // partial immutable stamps.
      expect(calls[1]?.query).toContain(
        's.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})',
      );
      expect(calls[1]?.params).toMatchObject({
        fromMs: T0 - 10_000,
        toMs: T0 + 10_000,
        updatedBeforeMs: SOURCE_NOW_MS - QUIET_MS,
      });
      // The operator is told deferred rows may exist — re-run later.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('quiet period on the update axis'),
      );

      warn.mockRestore();
    });

    it('MUST page by the (OccurredAt, TraceId) tuple cursor instead of buffering the window whole (audit C-6.3)', async () => {
      const fullPage = Array.from({ length: WINDOW_PAGE_SIZE }, (_, index) =>
        summaryRow(
          `trace-${String(index).padStart(4, '0')}`,
          T0 + index,
        ),
      );
      const { queryFn, calls } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }], // sourceNow
        fullPage, // page 1 summaries
        [], // page 1 spans
        [summaryRow('trace-last', T0 + WINDOW_PAGE_SIZE)], // page 2
        [], // page 2 spans
      ]);
      const sut = makeSut(queryFn);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const pages: SourceTrace[][] = [];

      for await (const page of sut.fetchTracesPaged({
        from: new Date(T0 - 10_000),
        to: new Date(T0 + 60_000),
      })) {
        pages.push(page);
      }

      expect(pages).toHaveLength(2);
      expect(pages[0]).toHaveLength(WINDOW_PAGE_SIZE);
      expect(pages[1]?.map((trace) => trace.traceId)).toEqual(['trace-last']);
      // Second page resumes past the first page's last raw row.
      expect(calls[3]?.params).toMatchObject({
        afterOccurredAtMs: fullPage[fullPage.length - 1]?.occurredAtMs,
        afterTraceId: 'trace-0999',
        limit: WINDOW_PAGE_SIZE,
      });

      warn.mockRestore();
    });

    it('MUST salvage a summary row whose bad token counts the SPAN usage rebuilds — and record the salvage durably (audit C-6.2)', async () => {
      const badTokens = {
        ...summaryRow('trace-salvage', T0),
        promptTokens: -5,
      };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }],
        [badTokens],
        [llmSpanRow('trace-salvage', { input: '313', output: '9' })],
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      // Salvaged, not poison: content preserved, the corrupt count
      // replaced by the span-level usage sum (never nulled into a zero).
      expect(traces.map((trace) => trace.traceId)).toEqual(['trace-salvage']);
      expect(traces[0]?.tokens).toMatchObject({ input: 313, output: 5 });
      // A console.warn is not a trail (C-6.2): the salvage is durable, and
      // distinguishable from a skip by its own kind.
      expect(poisonRepo.records).toEqual([
        expect.objectContaining({
          kind: 'summary_salvaged',
          id: 'trace-salvage',
          context: `window=[${WINDOW.from.toISOString()}, ${WINDOW.to.toISOString()})`,
          error: expect.stringContaining('promptTokens'),
          rawRow: badTokens,
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('salvaged'));

      warn.mockRestore();
    });

    it('MUST keep a bad-token row POISON when NO span usage rebuilds the count — an unknown cost is never stamped R$ 0,00 (invariant 2)', async () => {
      const badTokens = {
        ...summaryRow('trace-unrescuable', T0),
        promptTokens: -5,
        completionTokens: -2,
      };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }],
        [badTokens],
        [], // no spans at all — nothing to reconstruct the counts from
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      // Skipped: with zero used token types the stamper would find no
      // missing price and freeze an immutable R$ 0,00 no reprocess can
      // ever revisit. A durable poison record beats a wrong stamp.
      expect(traces).toEqual([]);
      expect(poisonRepo.records).toEqual([
        expect.objectContaining({
          kind: 'summary',
          id: 'trace-unrescuable',
          error: expect.stringContaining('R$ 0,00'),
          rawRow: badTokens,
        }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('poison summary row skipped'),
      );

      warn.mockRestore();
    });

    it('MUST keep a PARTIALLY corrupt row poison when the spans rebuild only the other count — no type is silently priced at zero', async () => {
      const badPrompt = {
        ...summaryRow('trace-partial', T0),
        promptTokens: -5, // corrupt: nulled at the boundary
        completionTokens: 9, // healthy
      };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }],
        [badPrompt],
        // The span carries OUTPUT usage only — the nulled prompt count
        // stays unknown.
        [llmSpanRow('trace-partial', { output: '9' })],
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      expect(traces).toEqual([]);
      expect(poisonRepo.records).toEqual([
        expect.objectContaining({
          kind: 'summary',
          id: 'trace-partial',
          error: expect.stringContaining('promptTokens'),
        }),
      ]);

      warn.mockRestore();
    });

    it('MUST salvage a PARTIALLY corrupt row when the spans rebuild exactly the nulled count', async () => {
      const badPrompt = {
        ...summaryRow('trace-partial-ok', T0),
        promptTokens: -5,
        completionTokens: 9,
      };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [{ nowMs: SOURCE_NOW_MS }],
        [badPrompt],
        [llmSpanRow('trace-partial-ok', { input: '313' })],
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      expect(traces.map((trace) => trace.traceId)).toEqual([
        'trace-partial-ok',
      ]);
      // Span-derived prompt tokens; the healthy summary count untouched.
      expect(traces[0]?.tokens).toMatchObject({ input: 313, output: 9 });
      expect(poisonRepo.records).toEqual([
        expect.objectContaining({
          kind: 'summary_salvaged',
          id: 'trace-partial-ok',
        }),
      ]);

      warn.mockRestore();
    });
  });

  describe('Durable poison trail (audit C-6.2)', () => {
    it('MUST persist a skipped summary row into the poison repository', async () => {
      const poison = { traceId: 'trace-poison', updatedAtMs: T0 + 2_000 };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [summaryRow('trace-a', T0 + 1_000), poison],
        [],
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await sut.fetchBatch({
        after: null,
        limit: 2,
        updatedBefore: new Date(T0 + 60_000),
      });

      expect(poisonRepo.records).toEqual([
        expect.objectContaining({
          kind: 'summary',
          id: 'trace-poison',
          context: 'cursor=start',
          rawRow: poison,
        }),
      ]);

      warn.mockRestore();
    });

    it('MUST persist a skipped span row into the poison repository', async () => {
      const badSpan = { spanId: 'span-poison', traceId: 'trace-a' };
      const poisonRepo = new PoisonRowRepositoryStub();
      const { queryFn } = makeQueryStub([
        [summaryRow('trace-a', T0)],
        [badSpan],
      ]);
      const sut = makeSut(queryFn, undefined, poisonRepo);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await sut.fetchBatch({
        after: null,
        limit: 1,
        updatedBefore: new Date(T0 + 60_000),
      });

      expect(poisonRepo.records).toEqual([
        expect.objectContaining({ kind: 'span', id: 'span-poison' }),
      ]);

      warn.mockRestore();
    });
  });

  describe('sourceNow (audit C-6.4)', () => {
    it('MUST read the source clock via now64', async () => {
      const { queryFn, calls } = makeQueryStub([[{ nowMs: SOURCE_NOW_MS }]]);
      const sut = makeSut(queryFn);

      const now = await sut.sourceNow();

      expect(now).toEqual(new Date(SOURCE_NOW_MS));
      expect(calls[0]?.query).toContain('now64');
    });

    it('MUST fail loudly on an unusable clock value — never guess the ceiling', async () => {
      const { queryFn } = makeQueryStub([[{}]]);

      await expect(makeSut(queryFn).sourceNow()).rejects.toThrow(/clock/);
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

  describe('cursor integrity (audit A-3 — null timestamps and stalled cursors)', () => {
    const WINDOW = {
      from: new Date(T0 - 10_000),
      to: new Date(T0 + 10_000),
    };

    it('MUST build the batch cursor from the last WELL-FORMED row — a JSON null timestamp is not epoch 0', async () => {
      // Number(null) === 0 passes isFinite, so the old guard turned a
      // null-timestamped last row into an epoch-0 cursor: the CAS refused
      // the regression, the watermark froze, and the drain loop re-fetched
      // the identical batch forever with no error and no backoff.
      const poisonTail = {
        ...summaryRow('trace-null-ts', T0 + 2_000),
        occurredAtMs: null,
        updatedAtMs: null,
      };
      const { queryFn } = makeQueryStub([
        [summaryRow('trace-good', T0), poisonTail],
        [], // spans
      ]);
      const sut = makeSut(queryFn, undefined, new PoisonRowRepositoryStub());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const batch = await sut.fetchBatch({
        after: null,
        limit: 2,
        updatedBefore: new Date(SOURCE_NOW_MS),
      });

      expect(batch.nextCursor).toEqual({
        updatedAt: new Date(T0),
        traceId: 'trace-good',
      });

      warn.mockRestore();
    });

    it('MUST terminate the windowed pager when the page tail is null-timestamped — skip, never spin', async () => {
      // Param-driven stub: serves the full page while the cursor is at the
      // window start, empty after a real advance. Pre-fix, the epoch-0
      // cursor kept the query anchored at the start and this looped until
      // the jest timeout.
      const fullPage = Array.from({ length: WINDOW_PAGE_SIZE - 1 }, (_, i) =>
        summaryRow(`trace-${String(i).padStart(4, '0')}`, T0 + i),
      );
      const nullTail = {
        ...summaryRow('trace-zzzz', T0 + 5_000),
        occurredAtMs: null,
        updatedAtMs: null,
      };
      const pages: RecordedQuery[] = [];
      const queryFn: QueryFn = async (query, params) => {
        if (query.includes('now64')) return [{ nowMs: SOURCE_NOW_MS }];
        if (query.includes('SpanAttributes') || query.includes('span')) return [];
        pages.push({ query, params });

        return (params['afterOccurredAtMs'] as number) === 0
          ? [...fullPage, nullTail]
          : [];
      };
      const sut = makeSut(queryFn, undefined, new PoisonRowRepositoryStub());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const traces = await fetchAll(sut, WINDOW);

      expect(traces).toHaveLength(WINDOW_PAGE_SIZE - 1);
      expect(pages).toHaveLength(2); // full page, then the empty terminator

      warn.mockRestore();
    });

    it('MUST crash — not loop — when a source keeps serving a page that does not advance the window cursor', async () => {
      const fullPage = Array.from({ length: WINDOW_PAGE_SIZE }, (_, i) =>
        summaryRow(`trace-${String(i).padStart(4, '0')}`, T0 + i),
      );
      const queryFn: QueryFn = async (query) => {
        if (query.includes('now64')) return [{ nowMs: SOURCE_NOW_MS }];
        if (query.includes('SpanAttributes') || query.includes('span')) return [];

        return fullPage; // malicious/broken source: same page forever
      };
      const sut = makeSut(queryFn, undefined, new PoisonRowRepositoryStub());
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(fetchAll(sut, WINDOW)).rejects.toThrow(
        /cursor failed to advance/,
      );

      warn.mockRestore();
    });
  });

});
