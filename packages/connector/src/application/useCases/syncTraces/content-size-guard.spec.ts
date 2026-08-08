import {
  MAX_TRACE_DOCUMENT_BYTES,
  truncateOversizedContent,
} from './content-size-guard.js';
import { EstimateDocumentBytes } from '../../interfaces/ingest-failure-repository.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-001',
  type: 'chat',
  channel: { type: 'whatsapp' },
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 1200, output: 350 },
  tokensTotal: 1550,
  pricingStatus: 'stamped',
  totalCostMicrocents: 100,
  ingestedAt: new Date('2026-06-05T14:20:00.000Z'),
  input: 'entrada',
  output: 'saída',
  spans: [
    {
      spanId: 'span-1',
      type: 'llm',
      name: 'chat',
      startedAt: new Date('2026-06-05T14:00:00.000Z'),
      finishedAt: new Date('2026-06-05T14:00:02.000Z'),
      durationMs: 2000,
      offsetMs: 0,
      status: 'ok',
      input: 'pergunta',
      output: 'resposta',
    },
  ],
  ...overrides,
});

describe('truncateOversizedContent (audit B-3/Q8)', () => {
  it('MUST leave a document under the cap untouched — same reference, no flag', () => {
    const trace = makeTrace();
    const result = truncateOversizedContent(trace, () => 1024);

    expect(result).toEqual({ trace, truncated: false });
    expect(result.trace).toBe(trace);
    expect(result.trace.contentTruncated).toBeUndefined();
  });

  it('MUST clip span content to markers and flag the trace when over the cap', () => {
    // First estimate (full doc) is oversized; everything after fits.
    const estimates = [MAX_TRACE_DOCUMENT_BYTES + 1, 64, 64, 512];
    const estimator: EstimateDocumentBytes = () => estimates.shift() ?? 512;

    const result = truncateOversizedContent(makeTrace(), estimator);

    expect(result.truncated).toBe(true);
    expect(result.truncated && result.originalBytes).toBe(
      MAX_TRACE_DOCUMENT_BYTES + 1,
    );
    expect(result.trace.contentTruncated).toBe(true);
    expect(result.trace.spans[0]?.input).toEqual({
      truncated: true,
      originalBytes: 64,
    });
    expect(result.trace.spans[0]?.output).toEqual({
      truncated: true,
      originalBytes: 64,
    });
    // Spans were enough — trace-level payloads survive.
    expect(result.trace.input).toBe('entrada');
    expect(result.trace.output).toBe('saída');
    // Tokens and the stamp are untouched — costs come from counts.
    expect(result.trace.tokensTotal).toBe(1550);
    expect(result.trace.totalCostMicrocents).toBe(100);
  });

  it('MUST also clip trace-level content when spans alone are not enough', () => {
    // Full doc oversized; span markers estimated; the re-check is STILL
    // oversized; then the trace-level markers.
    const oversized = MAX_TRACE_DOCUMENT_BYTES + 1;
    const estimates = [oversized, 64, 64, oversized, 32, 32];
    const estimator: EstimateDocumentBytes = () => estimates.shift() ?? 512;

    const result = truncateOversizedContent(makeTrace(), estimator);

    expect(result.trace.input).toEqual({ truncated: true, originalBytes: 32 });
    expect(result.trace.output).toEqual({ truncated: true, originalBytes: 32 });
    expect(result.trace.contentTruncated).toBe(true);
  });

  it('MUST keep absent span content absent — no marker invented for nothing', () => {
    const estimates = [MAX_TRACE_DOCUMENT_BYTES + 1];
    const estimator: EstimateDocumentBytes = () => estimates.shift() ?? 64;
    const trace = makeTrace({
      spans: [
        {
          spanId: 'span-1',
          type: 'tool',
          name: 'lookup',
          startedAt: new Date('2026-06-05T14:00:00.000Z'),
          finishedAt: new Date('2026-06-05T14:00:01.000Z'),
          durationMs: 1000,
          offsetMs: 0,
          status: 'ok',
          input: undefined,
          output: undefined,
        },
      ],
    });

    const result = truncateOversizedContent(trace, estimator);

    expect(result.trace.spans[0]?.input).toBeUndefined();
    expect(result.trace.spans[0]?.output).toBeUndefined();
  });
});
