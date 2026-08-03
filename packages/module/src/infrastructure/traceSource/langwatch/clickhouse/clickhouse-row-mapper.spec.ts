import { SourceTrace } from '../../../../application/interfaces/trace-source-client.js';
import { unreconstructedTokenCounts } from '../../token-salvage-gate.js';
import {
  SalvageableTokenField,
  SpanRow,
  SummaryRow,
} from './clickhouse-row-schema.js';
import {
  corruptTokenCounts,
  mapSummaryTrace,
} from './clickhouse-row-mapper.js';

// Shapes taken from REAL rows of the live 3.5.0 instance (decision 59):
// an agno/OTel agent trace with a root agent span and one llm child.

const T0 = new Date('2026-07-23T13:04:05.609Z').getTime();

const makeSummary = (overrides?: Partial<SummaryRow>): SummaryRow => ({
  traceId: 'trace-1',
  occurredAtMs: T0,
  updatedAtMs: T0 + 9_000,
  attributes: {
    'service.name': 'martino',
    'agent.version': '0.1.0',
    'agent.instance': 'martino-dev-1',
    'gen_ai.conversation.id': 'ui-ag5hlsbl',
    'langwatch.reserved.cache_creation_tokens': '1084',
  },
  computedInput: 'Obrigado!',
  computedOutput: 'De nada! 😊',
  totalDurationMs: 2288,
  containsError: false,
  errorMessage: null,
  promptTokens: 313,
  completionTokens: 9,
  rootSpanType: 'agent',
  ...overrides,
});

const makeRootSpan = (overrides?: Partial<SpanRow>): SpanRow => ({
  traceId: 'trace-1',
  spanId: 'span-root',
  parentSpanId: null,
  name: 'Martino.arun',
  startedAtMs: T0,
  endedAtMs: T0 + 2288,
  statusCode: 1,
  statusMessage: null,
  attributes: {
    'langwatch.span.type': 'agent',
    'service.version': '0.1.0',
    'langwatch.input': 'Obrigado!',
    'langwatch.output': 'De nada! 😊',
    'langwatch.reserved.value_types':
      '["langwatch.input=text","langwatch.output=text"]',
  },
  ...overrides,
});

const makeLlmSpan = (overrides?: Partial<SpanRow>): SpanRow => ({
  traceId: 'trace-1',
  spanId: 'span-llm',
  parentSpanId: 'span-root',
  name: 'Claude.ainvoke',
  startedAtMs: T0 + 21,
  endedAtMs: T0 + 1766,
  statusCode: 1,
  statusMessage: null,
  attributes: {
    'langwatch.span.type': 'llm',
    'gen_ai.request.model': 'claude-sonnet-5',
    'gen_ai.response.model': 'claude-sonnet-5',
    'gen_ai.usage.input_tokens': '313',
    'gen_ai.usage.output_tokens': '9',
    'gen_ai.usage.cache_creation.input_tokens': '1084',
    'gen_ai.output.messages': '[{"role":"assistant","content":"De nada! 😊"}]',
    'langwatch.input': '{"messages":[{"role":"user","content":"Obrigado!"}]}',
    'langwatch.output': '[{"role":"assistant","content":"De nada! 😊"}]',
    'langwatch.reserved.value_types':
      '["gen_ai.output.messages=chat_messages","langwatch.input=json","langwatch.output=json"]',
  },
  ...overrides,
});

describe('mapSummaryTrace', () => {
  it('MUST map a real-shaped summary+spans into the T1 contract', () => {
    const trace = mapSummaryTrace(makeSummary(), [
      makeLlmSpan(),
      makeRootSpan(),
    ]);

    expect(trace.traceId).toBe('trace-1');
    expect(trace.sessionId).toBe('ui-ag5hlsbl'); // gen_ai.conversation.id
    expect(trace.agent).toEqual({
      id: 'martino', // service.name fallback
      version: '0.1.0',
      instance: 'martino-dev-1',
    });
    expect(trace.model).toBe('claude-sonnet-5');
    expect(trace.type).toBe('agent');
    expect(trace.startedAt).toEqual(new Date(T0));
    expect(trace.finishedAt).toEqual(new Date(T0 + 2288));
    expect(trace.status).toBe('ok');
    expect(trace.tokens).toEqual({
      input: 313,
      output: 9,
      cache_write: 1084, // langwatch.reserved.cache_creation_tokens
    });
    expect(trace.input).toBe('Obrigado!');
    expect(trace.output).toBe('De nada! 😊');
    // Spans sorted by start — root first despite input order.
    expect(trace.spans.map((span) => span.spanId)).toEqual([
      'span-root',
      'span-llm',
    ]);
  });

  it('MUST map llm span tokens from gen_ai.usage.* string attributes', () => {
    const trace = mapSummaryTrace(makeSummary(), [
      makeRootSpan(),
      makeLlmSpan(),
    ]);
    const llm = trace.spans[1];

    expect(llm?.type).toBe('llm');
    expect(llm?.tokens).toEqual({ input: 313, output: 9, cache_write: 1084 });
    // Fidelity with the HTTP API: declared-json input is PARSED; a
    // chat_messages output (gen_ai.output.messages present) stays RAW.
    expect(llm?.input).toEqual({
      messages: [{ role: 'user', content: 'Obrigado!' }],
    });
    expect(llm?.output).toBe(
      '[{"role":"assistant","content":"De nada! 😊"}]',
    );
  });

  it('MUST keep declared-text span content as the raw source string', () => {
    const trace = mapSummaryTrace(makeSummary(), [makeRootSpan()]);

    expect(trace.spans[0]?.input).toBe('Obrigado!');
    expect(trace.spans[0]?.output).toBe('De nada! 😊');
  });

  it('MUST map multi-model traces to model undefined (never the wrong price)', () => {
    const trace = mapSummaryTrace(makeSummary(), [
      makeRootSpan(),
      makeLlmSpan(),
      makeLlmSpan({
        spanId: 'span-llm-2',
        attributes: {
          'langwatch.span.type': 'llm',
          'gen_ai.response.model': 'claude-haiku-4-5',
        },
      }),
    ]);

    expect(trace.model).toBeUndefined();
  });

  it('MUST fall back to summing span tokens when summary counts are null', () => {
    const trace = mapSummaryTrace(
      makeSummary({
        promptTokens: null,
        completionTokens: null,
        attributes: { 'service.name': 'martino' },
      }),
      [makeRootSpan(), makeLlmSpan()],
    );

    expect(trace.tokens.input).toBe(313);
    expect(trace.tokens.output).toBe(9);
    expect(trace.tokens.cache_write).toBe(1084); // summed from the span
  });

  it('MUST mark error traces and error spans', () => {
    const trace = mapSummaryTrace(
      makeSummary({ containsError: true, errorMessage: 'boom' }),
      [
        makeRootSpan({ statusCode: 2, statusMessage: 'agent exploded' }),
      ],
    );

    expect(trace.status).toBe('error');
    expect(trace.spans[0]?.status).toBe('error');
    expect(trace.spans[0]?.errorMessage).toBe('agent exploded');
  });

  it('MUST read REST-collector metadata (metadata.* prefixed keys)', () => {
    // Collector-pushed traces (demo seed) store user metadata PREFIXED —
    // metadata.agent, metadata.channel, ... — unlike OTel traces (bare
    // keys). Regression: the seeded demo landed with agent null.
    const trace = mapSummaryTrace(
      makeSummary({
        attributes: {
          'metadata.agent': 'agent-atendimento',
          'metadata.agent.version': '1.4.2',
          'metadata.agent.instance': 'atendimento-7d9f4b',
          'metadata.channel': 'whatsapp',
          'metadata.channel.version': '2.1',
          'metadata.domain': 'varejo',
          'metadata.subdomain': 'cobranca',
          'langwatch.thread.id': 'sess-0001',
        },
      }),
      [],
    );

    expect(trace.agent).toEqual({
      id: 'agent-atendimento',
      version: '1.4.2',
      instance: 'atendimento-7d9f4b',
    });
    expect(trace.channel).toEqual({
      type: 'whatsapp',
      version: '2.1',
      instance: undefined,
    });
    expect(trace.domain).toBe('varejo');
    expect(trace.subdomain).toBe('cobranca');
    expect(trace.sessionId).toBe('sess-0001');
  });

  it('MUST read trace metadata fallbacks from the root span resources', () => {
    const trace = mapSummaryTrace(
      makeSummary({
        attributes: { 'gen_ai.conversation.id': 'session-9' },
      }),
      [
        makeRootSpan({
          attributes: {
            'langwatch.span.type': 'agent',
            'service.name': 'from-resources',
            'service.version': '2.0.0',
            'channel': 'whatsapp',
          },
        }),
      ],
    );

    expect(trace.agent?.id).toBe('from-resources');
    expect(trace.agent?.version).toBe('2.0.0');
    expect(trace.channel.type).toBe('whatsapp');
  });

  it('MUST survive a spanless trace (channel unknown, type from summary)', () => {
    const trace = mapSummaryTrace(makeSummary(), []);

    expect(trace.spans).toEqual([]);
    expect(trace.type).toBe('agent'); // RootSpanType column
    expect(trace.channel.type).toBe('unknown');
    expect(trace.model).toBeUndefined();
  });

  it('MUST read userId with the fallback chain user_id ∥ langwatch.user.id ∥ user.id (decision 70)', () => {
    const withAll = mapSummaryTrace(
      makeSummary({
        attributes: {
          'user_id': 'u-canonical',
          'langwatch.user.id': 'u-reserved',
          'user.id': 'u-native',
        },
      }),
      [],
    );
    const withReserved = mapSummaryTrace(
      makeSummary({
        attributes: { 'langwatch.user.id': 'u-reserved', 'user.id': 'u-native' },
      }),
      [],
    );
    const withNative = mapSummaryTrace(
      makeSummary({ attributes: { 'user.id': 'u-native' } }),
      [],
    );
    const without = mapSummaryTrace(makeSummary(), []);

    expect(withAll.userId).toBe('u-canonical');
    expect(withReserved.userId).toBe('u-reserved');
    expect(withNative.userId).toBe('u-native');
    expect(without.userId).toBeUndefined();
  });

  it('MUST read environment from deployment.environment (∥ .name)', () => {
    const semconvOld = mapSummaryTrace(
      makeSummary({ attributes: { 'deployment.environment': 'prod' } }),
      [],
    );
    const semconvNew = mapSummaryTrace(
      makeSummary({ attributes: { 'deployment.environment.name': 'staging' } }),
      [],
    );

    expect(semconvOld.environment).toBe('prod');
    expect(semconvNew.environment).toBe('staging');
    expect(mapSummaryTrace(makeSummary(), []).environment).toBeUndefined();
  });

  it('MUST build the experiment block only when ab.experiment AND ab.variant are present', () => {
    const full = mapSummaryTrace(
      makeSummary({
        attributes: {
          'ab.experiment': 'assistant-tone',
          'ab.variant': 'B',
          'ab.variant_version': '2',
        },
      }),
      [],
    );
    const noVariant = mapSummaryTrace(
      makeSummary({ attributes: { 'ab.experiment': 'assistant-tone' } }),
      [],
    );
    const noVersion = mapSummaryTrace(
      makeSummary({
        attributes: { 'ab.experiment': 'assistant-tone', 'ab.variant': 'A' },
      }),
      [],
    );

    expect(full.experiment).toEqual({
      name: 'assistant-tone',
      variant: 'B',
      variantVersion: '2',
    });
    expect(noVariant.experiment).toBeUndefined();
    expect(noVersion.experiment).toEqual({
      name: 'assistant-tone',
      variant: 'A',
      variantVersion: undefined,
    });
  });

  it('MUST fall back to OpenInference cache keys when gen_ai.usage.* is absent (decision 72)', () => {
    const trace = mapSummaryTrace(
      makeSummary({
        attributes: {},
        promptTokens: null,
        completionTokens: null,
      }),
      [
        makeRootSpan(),
        makeLlmSpan({
          attributes: {
            'langwatch.span.type': 'llm',
            'gen_ai.response.model': 'claude-sonnet-5',
            'llm.token_count.prompt_details.cache_read': '500',
            'llm.token_count.prompt_details.cache_write': '1200',
          },
        }),
      ],
    );

    expect(trace.spans[1]?.tokens).toEqual({
      cache_read: 500,
      cache_write: 1200,
    });
    // Trace-level counts fall back to the span sum.
    expect(trace.tokens.cache_read).toBe(500);
    expect(trace.tokens.cache_write).toBe(1200);
  });

  it('MUST prefer gen_ai.usage.* over OpenInference keys when both exist', () => {
    const trace = mapSummaryTrace(makeSummary({ attributes: {} }), [
      makeRootSpan(),
      makeLlmSpan({
        attributes: {
          'langwatch.span.type': 'llm',
          'gen_ai.response.model': 'claude-sonnet-5',
          'gen_ai.usage.cache_creation.input_tokens': '1084',
          'llm.token_count.prompt_details.cache_write': '9999',
        },
      }),
    ]);

    expect(trace.spans[1]?.tokens).toEqual({ cache_write: 1084 });
  });
});

describe('the salvage half of the rule — nulled counts through the SHARED gate', () => {
  // The rule itself lives in token-salvage-gate.ts (one gate for every
  // source adapter); this mapper only translates its own field names.
  const unreconstructed = (
    trace: SourceTrace,
    fields: SalvageableTokenField[],
  ): string[] =>
    unreconstructedTokenCounts(trace, corruptTokenCounts(fields)).map(
      (count) => count.field,
    );

  const spanless = () =>
    mapSummaryTrace(
      makeSummary({
        attributes: {},
        promptTokens: null,
        completionTokens: null,
      }),
      [],
    );

  const withSpanUsage = () =>
    mapSummaryTrace(
      makeSummary({ promptTokens: null, completionTokens: null }),
      [makeRootSpan(), makeLlmSpan()],
    );

  it('MUST report nothing missing when the span usage sums rebuilt every nulled count', () => {
    const trace = withSpanUsage();

    expect(trace.tokens).toMatchObject({ input: 313, output: 9 });
    expect(
      unreconstructed(trace, ['completionTokens', 'promptTokens']),
    ).toEqual([]);
  });

  it('MUST report EVERY nulled count when no span carries usage — unknown usage is not zero (invariant 2)', () => {
    const trace = spanless();

    expect(trace.tokens).toEqual({});
    expect(
      unreconstructed(trace, ['completionTokens', 'promptTokens']),
    ).toEqual(['completionTokens', 'promptTokens']);
  });

  it('MUST report only the count the spans left unrebuilt (partial corruption)', () => {
    const trace = mapSummaryTrace(
      makeSummary({ promptTokens: null, completionTokens: 9 }),
      [
        makeRootSpan(),
        makeLlmSpan({
          attributes: {
            'langwatch.span.type': 'llm',
            'gen_ai.response.model': 'claude-sonnet-5',
            'gen_ai.usage.output_tokens': '9',
          },
        }),
      ],
    );

    // The healthy count is irrelevant here — only promptTokens was nulled,
    // and nothing rebuilt it.
    expect(trace.tokens.input).toBeUndefined();
    expect(unreconstructed(trace, ['promptTokens'])).toEqual([
      'promptTokens',
    ]);
  });

  it('MUST treat a rebuilt-to-zero count as unreconstructed — a stamp at zero is never salvage', () => {
    const trace = mapSummaryTrace(
      makeSummary({ promptTokens: null, completionTokens: null }),
      [
        makeRootSpan(),
        makeLlmSpan({
          attributes: {
            'langwatch.span.type': 'llm',
            'gen_ai.response.model': 'claude-sonnet-5',
            'gen_ai.usage.input_tokens': '0',
            'gen_ai.usage.output_tokens': '9',
          },
        }),
      ],
    );

    expect(unreconstructed(trace, ['promptTokens'])).toEqual([
      'promptTokens',
    ]);
    expect(unreconstructed(trace, ['completionTokens'])).toEqual([]);
  });
});
