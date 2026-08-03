import { ClickHouseLangWatchClient } from './clickhouse/clickhouse-langwatch-client.js';
import { HttpLangWatchClient } from './http-langwatch-client.js';
import {
  PoisonRowRecord,
  PoisonRowRepository,
  SalvageablePoisonKind,
} from '../../../application/interfaces/poison-row-repository.js';
import {
  SourceTrace,
  SyncWindow,
} from '../../../application/interfaces/trace-source-client.js';

/**
 * Re-audit iteration 2, findings 3/11 — the ARCHITECTURAL half of the fix.
 * The invariant-2 salvage rule used to live INSIDE one of the two
 * TraceSourceClient adapters, so the guarantee was only as strong as which
 * adapter happened to be wired: the sibling ingested the same corrupt row
 * and stamped its unknown usage at R$ 0,00, immutably.
 *
 * This suite drives BOTH real adapters through the SAME scenarios and
 * asserts the SAME outcome contract, so a third adapter (or a change to
 * either of these two) cannot reintroduce the hole on one side only.
 * The third client, FakeTraceSourceClient, has no salvage path by
 * construction: sourceTraceListSchema rejects a corrupt count outright
 * (`int().nonnegative()`), so a fixture can never reach the stamper with
 * an unknown usage either.
 */

const T0 = new Date('2026-07-23T13:00:00.000Z').getTime();
const WINDOW: SyncWindow = {
  from: new Date(T0 - 10_000),
  to: new Date(T0 + 10_000),
};
const CONTEXT = `window=[${WINDOW.from.toISOString()}, ${WINDOW.to.toISOString()})`;
const TRACE_ID = 'trace-corrupt-counts';

interface SalvageScenario {
  /** Trace-level counts exactly as the SOURCE declares them. */
  declared: { prompt: number; completion: number };
  /** Span-level usage available to rebuild a rejected count. */
  spanUsage: { input?: number; output?: number };
}

interface AdapterRun {
  traces: SourceTrace[];
  records: PoisonRowRecord[];
}

interface AdapterUnderTest {
  name: string;
  kind: SalvageablePoisonKind;
  run: (scenario: SalvageScenario) => Promise<AdapterRun>;
}

class PoisonRowRepositoryStub implements PoisonRowRepository {
  records: PoisonRowRecord[] = [];

  async record(row: PoisonRowRecord): Promise<void> {
    this.records.push(row);
  }
}

const drain = async (
  source: { fetchTracesPaged: (window: SyncWindow) => AsyncIterable<SourceTrace[]> },
): Promise<SourceTrace[]> => {
  const traces: SourceTrace[] = [];

  for await (const page of source.fetchTracesPaged(WINDOW)) {
    traces.push(...page);
  }

  return traces;
};

const clickHouseAdapter: AdapterUnderTest = {
  name: 'ClickHouseLangWatchClient (raw rows)',
  kind: 'summary',
  run: async (scenario) => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const summary = {
      traceId: TRACE_ID,
      occurredAtMs: T0,
      updatedAtMs: T0,
      attributes: { 'service.name': 'martino' },
      computedInput: 'oi',
      computedOutput: 'olá',
      totalDurationMs: 1000,
      containsError: false,
      errorMessage: null,
      promptTokens: scenario.declared.prompt,
      completionTokens: scenario.declared.completion,
      rootSpanType: 'agent',
    };
    const span = {
      traceId: TRACE_ID,
      spanId: `${TRACE_ID}-llm`,
      parentSpanId: null,
      name: 'Claude.ainvoke',
      startedAtMs: T0,
      endedAtMs: T0 + 1_000,
      statusCode: 1,
      statusMessage: null,
      attributes: {
        'langwatch.span.type': 'llm',
        'gen_ai.response.model': 'anthropic/claude-sonnet-4-5',
        ...(scenario.spanUsage.input === undefined
          ? {}
          : { 'gen_ai.usage.input_tokens': String(scenario.spanUsage.input) }),
        ...(scenario.spanUsage.output === undefined
          ? {}
          : { 'gen_ai.usage.output_tokens': String(scenario.spanUsage.output) }),
      },
    };
    const results: unknown[][] = [
      [{ nowMs: T0 + 7_200_000 }], // sourceNow
      [summary],
      [span],
    ];
    let call = 0;
    const sut = new ClickHouseLangWatchClient({
      url: 'http://clickhouse:8123',
      username: 'default',
      password: 'langwatch',
      database: 'langwatch',
      poisonRowRepository: poisonRepo,
      queryFn: async () => results[call++] ?? [],
    });

    return { traces: await drain(sut), records: poisonRepo.records };
  },
};

const httpAdapter: AdapterUnderTest = {
  name: 'HttpLangWatchClient (detail payloads)',
  kind: 'http-detail',
  run: async (scenario) => {
    const poisonRepo = new PoisonRowRepositoryStub();
    const detail = {
      trace_id: TRACE_ID,
      metadata: { 'service.name': 'martino' },
      timestamps: { started_at: T0 },
      metrics: {
        total_time_ms: 1000,
        prompt_tokens: scenario.declared.prompt,
        completion_tokens: scenario.declared.completion,
      },
      error: null,
      input: { value: 'oi' },
      output: { value: 'olá' },
      spans: [
        {
          span_id: `${TRACE_ID}-llm`,
          type: 'llm',
          model: 'anthropic/claude-sonnet-4-5',
          timestamps: { started_at: T0, finished_at: T0 + 1_000 },
          metrics: {
            ...(scenario.spanUsage.input === undefined
              ? {}
              : { prompt_tokens: scenario.spanUsage.input }),
            ...(scenario.spanUsage.output === undefined
              ? {}
              : { completion_tokens: scenario.spanUsage.output }),
          },
        },
      ],
    };
    const fetchFn = (async (url: unknown) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/api/traces/search')
          ? { traces: [{ trace_id: TRACE_ID }], pagination: { totalHits: 1 } }
          : detail,
    })) as unknown as typeof fetch;
    const sut = new HttpLangWatchClient({
      endpoint: 'https://langwatch.example.com',
      apiKey: 'sk-lw-test',
      poisonRowRepository: poisonRepo,
      fetchFn,
    });

    return { traces: await drain(sut), records: poisonRepo.records };
  },
};

describe.each([clickHouseAdapter, httpAdapter])(
  'Invariant-2 token salvage gate — $name',
  (adapter: AdapterUnderTest) => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('MUST refuse a trace whose corrupt counts NOTHING rebuilds — unknown usage is never stamped R$ 0,00', async () => {
      const { traces, records } = await adapter.run({
        declared: { prompt: -3, completion: 100.5 },
        spanUsage: {},
      });

      expect(traces).toEqual([]);
      expect(records).toEqual([
        expect.objectContaining({
          kind: adapter.kind,
          id: TRACE_ID,
          context: CONTEXT,
          error: expect.stringContaining('R$ 0,00'),
        }),
      ]);
    });

    it('MUST salvage a trace whose corrupt counts the span usage rebuilds — priced on measured usage, recorded durably', async () => {
      const { traces, records } = await adapter.run({
        declared: { prompt: -3, completion: 100.5 },
        spanUsage: { input: 120_000, output: 8_000 },
      });

      expect(traces.map((trace) => trace.traceId)).toEqual([TRACE_ID]);
      expect(traces[0]?.tokens).toMatchObject({
        input: 120_000,
        output: 8_000,
      });
      expect(records).toEqual([
        expect.objectContaining({
          kind: `${adapter.kind}_salvaged`,
          id: TRACE_ID,
          context: CONTEXT,
        }),
      ]);
    });

    it('MUST refuse a PARTIALLY corrupt trace when the spans rebuild only the healthy half', async () => {
      const { traces, records } = await adapter.run({
        declared: { prompt: -3, completion: 8_000 },
        spanUsage: { output: 8_000 },
      });

      expect(traces).toEqual([]);
      expect(records).toEqual([
        expect.objectContaining({ kind: adapter.kind, id: TRACE_ID }),
      ]);
    });

    it('MUST leave a healthy trace untouched — the gate never fires on measured counts', async () => {
      const { traces, records } = await adapter.run({
        declared: { prompt: 120_000, completion: 8_000 },
        spanUsage: {},
      });

      expect(traces.map((trace) => trace.traceId)).toEqual([TRACE_ID]);
      expect(traces[0]?.tokens).toMatchObject({
        input: 120_000,
        output: 8_000,
      });
      expect(records).toEqual([]);
    });
  },
);
