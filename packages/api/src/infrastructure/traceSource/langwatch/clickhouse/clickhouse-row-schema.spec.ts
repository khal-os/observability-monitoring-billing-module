import { parseSummaryRow } from './clickhouse-row-schema.js';

const validRow = () => ({
  traceId: 'trace-a',
  occurredAtMs: 1_753_275_600_000,
  updatedAtMs: 1_753_275_605_000,
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

describe('parseSummaryRow — the C-6.2 salvage rule', () => {
  it('MUST pass a valid row through unchanged, unsalvaged', () => {
    const result = parseSummaryRow(validRow());

    expect(result).toMatchObject({
      ok: true,
      salvagedFields: [],
      row: expect.objectContaining({ traceId: 'trace-a', promptTokens: 10 }),
    });
  });

  it('MUST salvage a row whose ONLY defect is a fractional token count — nulling just that count', () => {
    const result = parseSummaryRow({ ...validRow(), promptTokens: 10.5 });

    expect(result).toMatchObject({
      ok: true,
      salvagedFields: ['promptTokens'],
      row: expect.objectContaining({
        traceId: 'trace-a',
        promptTokens: null,
        // The healthy count survives — only the offender is nulled.
        completionTokens: 5,
        // Content is preserved (the whole point over dropping the trace).
        computedInput: 'oi',
      }),
    });
  });

  it('MUST salvage negative counts on both token fields at once', () => {
    const result = parseSummaryRow({
      ...validRow(),
      promptTokens: -1,
      completionTokens: -2,
    });

    expect(result).toMatchObject({
      ok: true,
      salvagedFields: ['completionTokens', 'promptTokens'],
      row: expect.objectContaining({
        promptTokens: null,
        completionTokens: null,
      }),
    });
  });

  it('MUST keep a structurally broken row poison — missing identity is never salvaged', () => {
    const { traceId, ...withoutId } = validRow();

    expect(parseSummaryRow(withoutId)).toMatchObject({ ok: false });
  });

  it('MUST keep a row poison when bad tokens come WITH structural defects', () => {
    const row: Record<string, unknown> = {
      ...validRow(),
      promptTokens: -1,
    };

    delete row['occurredAtMs'];

    expect(parseSummaryRow(row)).toMatchObject({ ok: false });
  });

  it('MUST keep non-object garbage poison', () => {
    expect(parseSummaryRow(null)).toMatchObject({ ok: false });
    expect(parseSummaryRow('not a row')).toMatchObject({ ok: false });
  });
});
