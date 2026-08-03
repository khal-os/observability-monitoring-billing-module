import { parseApiTrace } from './langwatch-api-schema.js';

const validDetail = () => ({
  trace_id: 'trace-a',
  metadata: { thread_id: 'thread-1' },
  timestamps: { started_at: 1_784_057_846_000 },
  metrics: { total_time_ms: 1200, prompt_tokens: 10, completion_tokens: 5 },
  error: null,
  input: { value: 'oi' },
  output: { value: 'olá' },
  spans: [
    {
      span_id: 'span-1',
      type: 'llm',
      model: 'anthropic/claude-sonnet-4-5',
      timestamps: { started_at: 1_784_057_846_100, finished_at: 1_784_057_847_000 },
      metrics: { prompt_tokens: 10, completion_tokens: 5 },
    },
  ],
});

describe('parseApiTrace — the salvage rule at the detail boundary (invariant 2)', () => {
  it('MUST pass a valid detail through unchanged, with nothing nulled', () => {
    const result = parseApiTrace(validDetail());

    expect(result).toMatchObject({
      ok: true,
      nulledTokenFields: [],
      trace: expect.objectContaining({ trace_id: 'trace-a' }),
    });
  });

  it('MUST null ONLY the offending count when a fractional count is the sole defect — and REPORT it, so the gate can decide the salvage', () => {
    const detail = validDetail();
    const result = parseApiTrace({
      ...detail,
      metrics: { ...detail.metrics, prompt_tokens: 100.5 },
    });

    expect(result).toMatchObject({
      ok: true,
      // Reported, not silently repaired: this list is what the shared gate
      // checks against the span-level usage sums (invariant 2). Nulling is
      // also what lets the mapper's `?? sumSpanMetric(...)` fire — the `??`
      // would have consumed a present-but-invalid count.
      nulledTokenFields: ['prompt_tokens'],
      trace: expect.objectContaining({
        trace_id: 'trace-a',
        metrics: expect.objectContaining({
          prompt_tokens: null,
          // The healthy count survives — only the offender is nulled.
          completion_tokens: 5,
          // Content and identity are preserved.
          total_time_ms: 1200,
        }),
      }),
    });
  });

  it('MUST null negative counts on both token fields at once', () => {
    const detail = validDetail();
    const result = parseApiTrace({
      ...detail,
      metrics: { total_time_ms: 1200, prompt_tokens: -3, completion_tokens: -2 },
    });

    expect(result).toMatchObject({
      ok: true,
      nulledTokenFields: ['completion_tokens', 'prompt_tokens'],
      trace: expect.objectContaining({
        metrics: expect.objectContaining({
          prompt_tokens: null,
          completion_tokens: null,
        }),
      }),
    });
  });

  it('MUST keep a STRUCTURAL defect poison — only token counts are salvageable', () => {
    const detail = validDetail();
    const result = parseApiTrace({
      ...detail,
      trace_id: '',
      metrics: { ...detail.metrics, prompt_tokens: -3 },
    });

    expect(result.ok).toBe(false);
  });

  it('MUST keep a non-object metrics block poison — nothing to null there', () => {
    const result = parseApiTrace({ ...validDetail(), metrics: 42 });

    expect(result.ok).toBe(false);
  });

  it('MUST accept a legitimate zero count as healthy — zero usage is measured, not corrupt', () => {
    const detail = validDetail();
    const result = parseApiTrace({
      ...detail,
      metrics: { ...detail.metrics, prompt_tokens: 0 },
    });

    expect(result).toMatchObject({ ok: true, nulledTokenFields: [] });
  });
});
