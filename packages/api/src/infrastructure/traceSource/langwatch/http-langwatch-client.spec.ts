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
