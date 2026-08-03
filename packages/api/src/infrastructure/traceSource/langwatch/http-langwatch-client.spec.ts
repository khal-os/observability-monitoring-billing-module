import { HttpLangWatchClient } from './http-langwatch-client.js';
import {
  PoisonRowRecord,
  PoisonRowRepository,
} from '../../../application/interfaces/poison-row-repository.js';
import { SourceTrace, SyncWindow } from '../../../application/interfaces/trace-source-client.js';

const WINDOW = {
  from: new Date('2026-07-14T00:00:00.000Z'),
  to: new Date('2026-07-15T00:00:00.000Z'),
};

const IN_WINDOW_MS = new Date('2026-07-14T12:00:00.000Z').getTime();
const OUT_WINDOW_MS = WINDOW.to.getTime(); // half-open border: excluded

const makeDetail = (traceId: string, startedAt: number) => ({
  trace_id: traceId,
  metadata: { thread_id: 'thread-1' },
  timestamps: { started_at: startedAt },
  metrics: { total_time_ms: 1000, prompt_tokens: 10, completion_tokens: 5 },
  error: null,
  input: { value: 'oi' },
  output: { value: 'olá' },
  spans: [
    {
      span_id: `${traceId}-span`,
      type: 'llm',
      model: 'gpt-4o-mini',
      timestamps: { started_at: startedAt, finished_at: startedAt + 900 },
      metrics: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ],
});

interface RecordedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

const makeFetchStub = (
  pages: { trace_id: string }[][],
  totalHits: number | undefined,
  options: {
    detailOverrides?: Record<string, unknown>;
    failDetailOnce?: string;
  } = {},
) => {
  const calls: RecordedCall[] = [];
  const details: Record<string, unknown> = {
    'trace-a': makeDetail('trace-a', IN_WINDOW_MS),
    'trace-b': makeDetail('trace-b', IN_WINDOW_MS + 60_000),
    'trace-border': makeDetail('trace-border', OUT_WINDOW_MS),
    ...options.detailOverrides,
  };
  let searchCall = 0;
  let pendingDetailFailure = options.failDetailOnce;

  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
    });

    if (String(url).includes('/api/traces/search')) {
      const page = pages[searchCall] ?? [];

      searchCall += 1;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          traces: page,
          ...(totalHits === undefined
            ? {}
            : { pagination: { totalHits } }),
        }),
      };
    }

    const traceId = decodeURIComponent(
      String(url).split('/api/traces/')[1]!.split('?')[0]!,
    );

    if (pendingDetailFailure === traceId) {
      pendingDetailFailure = undefined;

      throw new Error(`socket timeout fetching ${traceId}`);
    }

    return {
      ok: true,
      status: 200,
      json: async () => details[traceId],
    };
  }) as typeof fetch;

  return { calls, fetchFn };
};

class PoisonRowRepositoryStub implements PoisonRowRepository {
  records: PoisonRowRecord[] = [];

  async record(row: PoisonRowRecord): Promise<void> {
    this.records.push(row);
  }
}

/** Drains the paged contract — the HTTP path yields its single capped page. */
const fetchAll = async (
  sut: HttpLangWatchClient,
  window: SyncWindow,
): Promise<SourceTrace[]> => {
  const traces: SourceTrace[] = [];

  for await (const page of sut.fetchTracesPaged(window)) {
    traces.push(...page);
  }

  return traces;
};

describe('HttpLangWatchClient', () => {
  it('MUST authenticate with X-Auth-Token and fetch the full detail of each trace', async () => {
    const { fetchFn, calls } = makeFetchStub([[{ trace_id: 'trace-a' }]], 1);
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com/',
      apiKey: 'sk-lw-test',
      fetchFn,
    });

    const traces = await fetchAll(sut, WINDOW);

    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe('trace-a');
    expect(traces[0]?.sessionId).toBe('thread-1');
    expect(traces[0]?.model).toBe('gpt-4o-mini');

    expect(calls[0]?.url).toBe(
      'https://langwatch.example.com/api/traces/search',
    );
    expect(calls[0]?.headers['X-Auth-Token']).toBe('sk-lw-test');
    expect(calls[0]?.body).toEqual({
      pageSize: 100,
      pageOffset: 0,
      startDate: WINDOW.from.getTime(),
      endDate: WINDOW.to.getTime(),
    });
    expect(calls[1]?.url).toBe(
      'https://langwatch.example.com/api/traces/trace-a?format=json',
    );
  });

  it('MUST arm a timeout signal on every request (audit C-6.1)', async () => {
    const { fetchFn, calls } = makeFetchStub([[{ trace_id: 'trace-a' }]], 1);
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      fetchFn,
    });

    await fetchAll(sut, WINDOW);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('MUST retry a failed detail GET once — one flaky socket must not poison a healthy trace (audit C-6.1)', async () => {
    const { fetchFn, calls } = makeFetchStub([[{ trace_id: 'trace-a' }]], 1, {
      failDetailOnce: 'trace-a',
    });
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      fetchFn,
    });

    const traces = await fetchAll(sut, WINDOW);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
    // search + failed GET + retried GET
    expect(
      calls.filter((call) => call.url.includes('trace-a?format=json')),
    ).toHaveLength(2);
  });

  it('MUST refuse a window holding more hits than one page — QA14: pageOffset is ignored, looping would silently lose the excess', async () => {
    const { fetchFn, calls } = makeFetchStub(
      [[{ trace_id: 'trace-a' }], [{ trace_id: 'trace-b' }]],
      2,
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      pageSize: 1,
      fetchFn,
    });

    await expect(fetchAll(sut, WINDOW)).rejects.toThrow(/QA14/);

    // Fails BEFORE any detail fetch: one search call, nothing else — no
    // partial window is ever reported as a healthy sync.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/traces/search');
  });

  it('MUST treat a FULL page with missing pagination.totalHits as an error — the cap guard cannot see the excess (audit C-6.1)', async () => {
    const { fetchFn, calls } = makeFetchStub(
      [[{ trace_id: 'trace-a' }]],
      undefined, // LangWatch omitted `pagination`
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      pageSize: 1,
      fetchFn,
    });

    await expect(fetchAll(sut, WINDOW)).rejects.toThrow(/totalHits/);
    expect(calls).toHaveLength(1);
  });

  it('MUST tolerate a missing pagination block on a PARTIAL page — the window provably fits', async () => {
    const { fetchFn } = makeFetchStub([[{ trace_id: 'trace-a' }]], undefined);
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      pageSize: 100,
      fetchFn,
    });

    const traces = await fetchAll(sut, WINDOW);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
  });

  it('MUST skip a malformed detail, record it as poison, and keep the rest of the page (audit C-6.1/C-6.2)', async () => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const { fetchFn } = makeFetchStub(
      [[{ trace_id: 'trace-a' }, { trace_id: 'trace-broken' }]],
      2,
      { detailOverrides: { 'trace-broken': { nonsense: true } } },
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, WINDOW);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
    expect(poisonRepo.records).toEqual([
      expect.objectContaining({
        kind: 'http-detail',
        id: 'trace-broken',
        rawRow: { nonsense: true },
      }),
    ]);

    warn.mockRestore();
  });

  it('MUST refuse a detail whose corrupt token counts NOTHING rebuilds — an unknown cost is never stamped R$ 0,00 (invariant 2)', async () => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const corrupt = {
      ...makeDetail('trace-corrupt', IN_WINDOW_MS),
      // The instrumentation defect the raw-row source already refused:
      // present-but-invalid counts. The spans carry no usage at all, so
      // the real usage is UNKNOWN — ingesting the trace would stamp it at
      // R$ 0,00 immutably, unreachable by any reprocess.
      metrics: { total_time_ms: 1000, prompt_tokens: -3, completion_tokens: 100.5 },
      spans: [
        {
          span_id: 'trace-corrupt-span',
          type: 'llm',
          model: 'anthropic/claude-sonnet-4-5',
          timestamps: { started_at: IN_WINDOW_MS, finished_at: IN_WINDOW_MS + 900 },
        },
      ],
    };
    const { fetchFn } = makeFetchStub(
      [[{ trace_id: 'trace-a' }, { trace_id: 'trace-corrupt' }]],
      2,
      { detailOverrides: { 'trace-corrupt': corrupt } },
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, WINDOW);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
    // Skipped AND durably recorded — a poison record beats a wrong
    // immutable stamp (the raw-row source's rule, same gate).
    expect(poisonRepo.records).toEqual([
      expect.objectContaining({
        kind: 'http-detail',
        id: 'trace-corrupt',
        context: `window=[${WINDOW.from.toISOString()}, ${WINDOW.to.toISOString()})`,
        error: expect.stringContaining('R$ 0,00'),
        rawRow: corrupt,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('poison trace detail skipped'),
    );

    warn.mockRestore();
  });

  it('MUST salvage a detail whose corrupt counts the SPAN usage rebuilds — and record the salvage durably', async () => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const salvageable = {
      ...makeDetail('trace-salvage', IN_WINDOW_MS),
      metrics: { total_time_ms: 1000, prompt_tokens: -3, completion_tokens: 100.5 },
      spans: [
        {
          span_id: 'trace-salvage-span',
          type: 'llm',
          model: 'anthropic/claude-sonnet-4-5',
          timestamps: { started_at: IN_WINDOW_MS, finished_at: IN_WINDOW_MS + 900 },
          metrics: { prompt_tokens: 120_000, completion_tokens: 8_000 },
        },
      ],
    };
    const { fetchFn } = makeFetchStub([[{ trace_id: 'trace-salvage' }]], 1, {
      detailOverrides: { 'trace-salvage': salvageable },
    });
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, WINDOW);

    // Ingested with the MEASURED usage, never with the corrupt counts
    // dropped into a silent zero.
    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-salvage']);
    expect(traces[0]?.tokens).toMatchObject({ input: 120_000, output: 8_000 });
    // A console.warn is not a trail (C-6.2): the salvage is durable, and
    // distinguishable from a skip by its own kind.
    expect(poisonRepo.records).toEqual([
      expect.objectContaining({
        kind: 'http-detail_salvaged',
        id: 'trace-salvage',
        error: expect.stringContaining('metrics.prompt_tokens'),
        rawRow: salvageable,
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('salvaged'));

    warn.mockRestore();
  });

  it('MUST keep a PARTIALLY corrupt detail poison when the spans rebuild only the other count — no type is silently priced at zero', async () => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const partial = {
      ...makeDetail('trace-partial', IN_WINDOW_MS),
      // Only the prompt count is corrupt; the spans carry output usage
      // only, so the input usage stays unknown and would be billed at zero.
      metrics: { total_time_ms: 1000, prompt_tokens: -3, completion_tokens: 8_000 },
      spans: [
        {
          span_id: 'trace-partial-span',
          type: 'llm',
          model: 'anthropic/claude-sonnet-4-5',
          timestamps: { started_at: IN_WINDOW_MS, finished_at: IN_WINDOW_MS + 900 },
          metrics: { completion_tokens: 8_000 },
        },
      ],
    };
    const { fetchFn } = makeFetchStub([[{ trace_id: 'trace-partial' }]], 1, {
      detailOverrides: { 'trace-partial': partial },
    });
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, WINDOW);

    expect(traces).toEqual([]);
    expect(poisonRepo.records).toEqual([
      expect.objectContaining({
        kind: 'http-detail',
        id: 'trace-partial',
        error: expect.stringContaining('metrics.prompt_tokens'),
      }),
    ]);

    warn.mockRestore();
  });

  it('MUST throw when EVERY detail of a non-trivial page is poison — API drift, not isolated bad rows (decision 79 mirror)', async () => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const ids = Array.from({ length: 10 }, (_, index) => `trace-bad-${index}`);
    const { fetchFn } = makeFetchStub(
      [ids.map((trace_id) => ({ trace_id }))],
      10,
      {
        detailOverrides: Object.fromEntries(
          ids.map((id) => [id, { nonsense: true }]),
        ),
      },
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(fetchAll(sut, WINDOW)).rejects.toThrow(/drift/);
    // Every skip left a durable record before the breaker fired.
    expect(poisonRepo.records).toHaveLength(10);

    warn.mockRestore();
  });

  it('MUST enforce the half-open window locally — border trace excluded', async () => {
    const { fetchFn } = makeFetchStub(
      [[{ trace_id: 'trace-a' }, { trace_id: 'trace-border' }]],
      2,
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      fetchFn,
    });

    const traces = await fetchAll(sut, WINDOW);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-a']);
  });

  it('MUST defer a trace still receiving spans — the start-axis clamp cannot see the update axis (audit B-4)', async () => {
    const now = Date.now();
    // Upper bound 20 min back: the window itself clears the quiet period,
    // so ONLY the per-trace activity check can catch the live trace.
    const recentWindow = {
      from: new Date(now - 7_200_000),
      to: new Date(now - 1_200_000),
    };
    const settledStart = now - 6_000_000;
    const activeStart = now - 5_000_000;
    const { fetchFn } = makeFetchStub(
      [[{ trace_id: 'trace-settled' }, { trace_id: 'trace-active' }]],
      2,
      {
        detailOverrides: {
          'trace-settled': makeDetail('trace-settled', settledStart),
          'trace-active': {
            ...makeDetail('trace-active', activeStart),
            // Started inside the window, but a span landed a minute ago:
            // the trace is still being built, and its token counts with
            // it — stamping it now freezes a partial, immutable cost.
            spans: [
              {
                span_id: 'trace-active-span',
                type: 'llm',
                model: 'gpt-4o-mini',
                timestamps: {
                  started_at: activeStart,
                  finished_at: now - 60_000,
                },
                metrics: { prompt_tokens: 10, completion_tokens: 5 },
              },
            ],
          },
        },
      },
    );
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, recentWindow);

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-settled']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('trace deferred (traceId=trace-active)'),
    );
    // The operator is told the window is incomplete, same as the
    // ClickHouse path — the deferred rows stay in the source.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('re-run later to cover the rest'),
    );

    warn.mockRestore();
  });

  it('MUST NOT defer a settled trace whose window merely ends near now', async () => {
    const now = Date.now();
    const startedAt = now - 3_600_000;
    const { fetchFn } = makeFetchStub([[{ trace_id: 'trace-settled' }]], 1, {
      detailOverrides: {
        'trace-settled': makeDetail('trace-settled', startedAt),
      },
    });
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      fetchFn,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = await fetchAll(sut, {
      from: new Date(now - 7_200_000),
      to: new Date(now), // clamped back by the quiet period (decision 61)
    });

    expect(traces.map((trace) => trace.traceId)).toEqual(['trace-settled']);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('trace deferred'),
    );

    warn.mockRestore();
  });

  it('MUST fail loudly on a non-2xx response — never a silent empty sync', async () => {
    const fetchFn = (async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-wrong',
      fetchFn,
    });

    await expect(fetchAll(sut, WINDOW)).rejects.toThrow(/HTTP 401/);
  });
});
