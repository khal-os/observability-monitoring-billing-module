import { corruptMetricCounts, mapApiTrace } from './langwatch-api-mapper.js';
import { LangWatchApiTrace, parseApiTrace } from './langwatch-api-schema.js';

const makeApiTrace = (
  overrides: Partial<LangWatchApiTrace> = {},
): LangWatchApiTrace => ({
  trace_id: 'trace-real-001',
  metadata: {
    thread_id: 'thread-abc',
    agent: 'agent-atendimento',
    domain: 'varejo',
    subdomain: 'loja-sp',
    channel: 'whatsapp',
  },
  timestamps: { started_at: 1_784_057_846_000 },
  metrics: {
    total_time_ms: 4000,
    prompt_tokens: 1200,
    completion_tokens: 350,
  },
  error: null,
  input: { value: 'Oi, preciso de ajuda' },
  output: { value: 'Claro! Como posso ajudar?' },
  spans: [
    {
      span_id: 'span-1',
      parent_id: null,
      type: 'llm',
      name: 'llm-call',
      model: 'openai/gpt-5-mini',
      timestamps: {
        started_at: 1_784_057_846_100,
        finished_at: 1_784_057_849_900,
      },
      metrics: { prompt_tokens: 1200, completion_tokens: 350 },
    },
  ],
  ...overrides,
});

describe('mapApiTrace()', () => {
  it('MUST map the real payload into the T1 contract', () => {
    const mapped = mapApiTrace(makeApiTrace());

    expect(mapped).toEqual(
      expect.objectContaining({
        traceId: 'trace-real-001',
        sessionId: 'thread-abc',
        agent: { id: 'agent-atendimento' },
        model: 'openai/gpt-5-mini',
        type: 'llm',
        channel: { type: 'whatsapp' },
        domain: 'varejo',
        subdomain: 'loja-sp',
        status: 'ok',
        startedAt: new Date(1_784_057_846_000),
        finishedAt: new Date(1_784_057_850_000),
        tokens: { input: 1200, output: 350 },
        input: 'Oi, preciso de ajuda',
        output: 'Claro! Como posso ajudar?',
      }),
    );
    expect(mapped.spans).toHaveLength(1);
    expect(mapped.spans[0]?.status).toBe('ok');
  });

  it('MUST read cache tokens from the reserved metadata STRING keys', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metadata: {
          thread_id: 'thread-abc',
          'langwatch.reserved.cache_read_tokens': '65578',
          'langwatch.reserved.cache_creation_tokens': '2875',
        },
      }),
    );

    expect(mapped.tokens.cache_read).toBe(65_578);
    expect(mapped.tokens.cache_write).toBe(2_875);
  });

  it('MUST drop fractional or negative token counts at the boundary — a fractional count would stall the stamper forever', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metrics: { prompt_tokens: 100.5, completion_tokens: -3 },
      }),
    );

    expect(mapped.tokens.input).toBeUndefined();
    expect(mapped.tokens.output).toBeUndefined();
  });

  it('MUST rebuild a count the boundary NULLED from the span usage — the `??` must reach sumSpanMetric (invariant 2)', () => {
    // What parseApiTrace hands the mapper for a detail whose trace-level
    // counts were corrupt: nulled, so the span fallback can rescue them.
    // Before the salvage rule the raw -3/100.5 were consumed by the `??`,
    // the span sums were never read, and the trace was stamped R$ 0,00.
    const parsed = parseApiTrace(
      makeApiTrace({
        metrics: {
          total_time_ms: 4000,
          prompt_tokens: -3,
          completion_tokens: 100.5,
        },
        spans: [
          {
            span_id: 'span-1',
            type: 'llm',
            model: 'anthropic/claude-sonnet-4-5',
            timestamps: { started_at: 1, finished_at: 2 },
            metrics: { prompt_tokens: 120_000, completion_tokens: 8_000 },
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);

    const mapped = mapApiTrace(
      (parsed as { ok: true; trace: LangWatchApiTrace }).trace,
    );

    expect(mapped.tokens).toMatchObject({ input: 120_000, output: 8_000 });
  });

  it('MUST translate the nulled metric fields into the token types the shared gate checks', () => {
    expect(corruptMetricCounts(['completion_tokens', 'prompt_tokens'])).toEqual([
      { field: 'metrics.completion_tokens', tokenType: 'output' },
      { field: 'metrics.prompt_tokens', tokenType: 'input' },
    ]);
  });

  it('MUST fall back to summing span metrics when trace metrics are absent', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metrics: null,
        spans: [
          {
            span_id: 'span-1',
            type: 'llm',
            model: 'openai/gpt-5-mini',
            timestamps: { started_at: 1, finished_at: 2 },
            metrics: {
              prompt_tokens: 100,
              completion_tokens: 20,
              cache_read_input_tokens: 50,
            },
          },
          {
            span_id: 'span-2',
            type: 'llm',
            model: 'openai/gpt-5-mini',
            timestamps: { started_at: 3, finished_at: 4 },
            metrics: { prompt_tokens: 40, completion_tokens: 10 },
          },
        ],
      }),
    );

    expect(mapped.tokens).toEqual({
      input: 140,
      output: 30,
      cache_read: 50,
    });
  });

  it('MUST NOT pick a model for multi-model traces — they go honest pending, never mispriced', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        spans: [
          {
            span_id: 'span-1',
            type: 'llm',
            model: 'claude-opus-4-8',
            timestamps: { started_at: 1, finished_at: 2 },
          },
          {
            span_id: 'span-2',
            type: 'llm',
            model: 'claude-haiku-4-5-20251001',
            timestamps: { started_at: 3, finished_at: 4 },
          },
        ],
      }),
    );

    expect(mapped.model).toBeUndefined();
  });

  it('MUST fall back to service.name as agent and default channel/type honestly', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metadata: { 'service.name': 'claude-code' },
        spans: [],
      }),
    );

    expect(mapped.agent).toEqual({ id: 'claude-code' });
    expect(mapped.sessionId).toBeUndefined();
    expect(mapped.channel).toEqual({ type: 'unknown' });
    expect(mapped.type).toBe('unknown');
  });

  it('MUST read version and instance from the OTel resource semconv fallbacks', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metadata: {
          'service.name': 'agent-cobranca',
          'service.version': '2.0.1',
          'service.instance.id': 'agent-cobranca-5c8e2d-t7qh4',
          channel: 'whatsapp',
          'channel.version': '3.2.0',
          'channel.instance': 'omni-wa-6b4c9f-r3zs5',
        },
      }),
    );

    expect(mapped.agent).toEqual({
      id: 'agent-cobranca',
      version: '2.0.1',
      instance: 'agent-cobranca-5c8e2d-t7qh4',
    });
    expect(mapped.channel).toEqual({
      type: 'whatsapp',
      version: '3.2.0',
      instance: 'omni-wa-6b4c9f-r3zs5',
    });
  });

  it('MUST map errors from trace and spans defensively', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        error: { message: 'tool timeout', stacktrace: ['...'] },
        spans: [
          {
            span_id: 'span-1',
            type: 'tool',
            name: 'consulta-erp',
            error: 'socket hang up',
            timestamps: { started_at: 1, finished_at: 2 },
          },
        ],
      }),
    );

    expect(mapped.status).toBe('error');
    expect(mapped.spans[0]?.status).toBe('error');
    expect(mapped.spans[0]?.errorMessage).toBe('socket hang up');
  });

  it('MUST order spans chronologically regardless of API order', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        spans: [
          {
            span_id: 'span-late',
            type: 'llm',
            model: 'openai/gpt-5-mini',
            timestamps: { started_at: 200, finished_at: 300 },
          },
          {
            span_id: 'span-early',
            type: 'agent',
            parent_id: null,
            timestamps: { started_at: 100, finished_at: 400 },
          },
        ],
      }),
    );

    expect(mapped.spans.map((span) => span.spanId)).toEqual([
      'span-early',
      'span-late',
    ]);
  });

  it('MUST read userId with the fallback chain user_id ∥ langwatch.user.id ∥ user.id (decision 70)', () => {
    const canonical = mapApiTrace(
      makeApiTrace({
        metadata: {
          user_id: 'u-canonical',
          'langwatch.user.id': 'u-reserved',
          'user.id': 'u-native',
        },
      }),
    );
    const reserved = mapApiTrace(
      makeApiTrace({ metadata: { 'langwatch.user.id': 'u-reserved' } }),
    );

    expect(canonical.userId).toBe('u-canonical');
    expect(reserved.userId).toBe('u-reserved');
    expect(mapApiTrace(makeApiTrace()).userId).toBeUndefined();
  });

  it('MUST read environment and the A/B experiment block from metadata (decision 70)', () => {
    const mapped = mapApiTrace(
      makeApiTrace({
        metadata: {
          'deployment.environment': 'prod',
          'ab.experiment': 'assistant-tone',
          'ab.variant': 'B',
          'ab.variant_version': '2',
        },
      }),
    );
    const partial = mapApiTrace(
      makeApiTrace({ metadata: { 'ab.experiment': 'assistant-tone' } }),
    );

    expect(mapped.environment).toBe('prod');
    expect(mapped.experiment).toEqual({
      name: 'assistant-tone',
      variant: 'B',
      variantVersion: '2',
    });
    // Missing ab.variant → no half-built block.
    expect(partial.experiment).toBeUndefined();
    expect(partial.environment).toBeUndefined();
  });
});
