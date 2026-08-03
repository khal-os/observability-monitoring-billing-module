import { TraceModel } from '../../../domain/models/trace-model.js';
import { SpanModel } from '../../../domain/models/span-model.js';
import { EstimateDocumentBytes } from '../../interfaces/ingest-failure-repository.js';

/**
 * audit B-3 (Q8 approved): the store caps a document at 16MB, and one
 * trace = one self-contained document (decision 47) — a long agent
 * session can breach it. Guard at 15MB, leaving headroom for the driver
 * envelope and the null-padded write boundary. A truncated archived trace
 * beats a lost one: without this guard the same insert error repeats
 * every cycle and the whole sync stalls (the B-3 failure mode).
 */
export const MAX_TRACE_DOCUMENT_BYTES = 15 * 1024 * 1024;

/**
 * The truncation variant of the content shape. Content is stored verbatim
 * as `unknown` (decision 47) — when clipped, this marker replaces the
 * payload, never silently: `contentTruncated` on the trace plus the
 * ingest_failures event point straight at it.
 */
export interface TruncatedContent {
  truncated: true;
  /** Estimated serialized bytes of the replaced payload. */
  originalBytes: number;
}

export type SizeGuardResult =
  | { trace: TraceModel; truncated: false }
  | { trace: TraceModel; truncated: true; originalBytes: number };

/**
 * Pre-insert size guard (audit B-3): estimates the document's serialized
 * size and, above the cap, replaces span content (then trace-level
 * content, only if spans alone are not enough) with TruncatedContent
 * markers. Tokens and costs are UNTOUCHED — they come from counts, not
 * content — so the price stamp is exactly what it would have been.
 */
export const truncateOversizedContent = (
  trace: TraceModel,
  estimateBytes: EstimateDocumentBytes,
): SizeGuardResult => {
  const originalBytes = estimateBytes(trace);

  if (originalBytes <= MAX_TRACE_DOCUMENT_BYTES) {
    return { trace, truncated: false };
  }

  const marker = (content: unknown): TruncatedContent | undefined =>
    content === undefined
      ? undefined
      : { truncated: true, originalBytes: estimateBytes({ content }) };

  // Span content first — multi-MB conversations live there; the trace-
  // level payloads fall too only when clipping the spans is not enough.
  const spans: SpanModel[] = trace.spans.map((span) => ({
    ...span,
    input: marker(span.input),
    output: marker(span.output),
  }));

  let clipped: TraceModel = { ...trace, contentTruncated: true, spans };

  if (estimateBytes(clipped) > MAX_TRACE_DOCUMENT_BYTES) {
    clipped = {
      ...clipped,
      input: marker(trace.input),
      output: marker(trace.output),
    };
  }

  return { trace: clipped, truncated: true, originalBytes };
};
