import { ClickHouseLangWatchClient } from './clickhouse/clickhouse-langwatch-client.js';
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
 * The invariant-2 salvage rule used to live INSIDE one adapter, so the
 * guarantee was only as strong as which adapter happened to be wired: the
 * sibling ingested the same corrupt row and stamped its unknown usage at
 * R$ 0,00, immutably.
 *
 * This suite drives EVERY real adapter through the SAME scenarios and
 * asserts the SAME outcome contract — the adapter table below is the
 * tripwire: a new adapter joins it or reintroduces the hole on one side
 * only. Since decision 127 (no client will ever ingest over HTTP; the
 * HttpLangWatchClient was deleted) the table has one row, ClickHouse.
 * The other client, FakeTraceSourceClient, has no salvage path by
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


describe.each([clickHouseAdapter])(
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

    it('MUST fall back to span usage when the source DECLARES zero — a 0 counter is "not measured", never "free" (audit A-2)', async () => {
      // LangWatch's summary counters are non-nullable: an un-aggregated
      // roll-up reads 0, not null. `0 ?? spans` kept the 0, so a trace
      // with real span usage was stamped R$ 0,00 as `stamped` (not
      // pending — reprocess never revisits it), immutably. The declared
      // count is authoritative only when POSITIVE.
      const { traces, records } = await adapter.run({
        declared: { prompt: 0, completion: 0 },
        spanUsage: { input: 1200, output: 350 },
      });

      expect(traces.map((trace) => trace.traceId)).toEqual([TRACE_ID]);
      expect(traces[0]?.tokens).toMatchObject({
        input: 1200,
        output: 350,
      });
      // A healthy zero is not corruption: no poison row, no salvage row.
      expect(records).toEqual([]);
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
