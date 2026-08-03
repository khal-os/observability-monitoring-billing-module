import { TraceModel } from '@khal/core/domain/models/trace-model.js';
import { SpanModel } from '@khal/core/domain/models/span-model.js';
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
  | {
      trace: TraceModel;
      truncated: true;
      /**
       * re-audit 2026-08 (sync item 4): still over the cap after EVERY
       * clip pass — the document has no storable form. The caller must
       * NOT insert and must NOT record a truncation event (there is no
       * stored-but-clipped trace to audit); it dead-letters under the
       * honest 'oversized_unstorable' kind instead.
       */
      unstorable: boolean;
      originalBytes: number;
    };

/**
 * re-audit 2026-08 (sync item 4): thrown by the ingest path when the
 * guard reports `unstorable` — routed by the sync loops to a dead-letter
 * record with its own kind, so the failure is never mistaken for a
 * generic ingest error and never leaves a truncation record describing a
 * store that did not happen.
 */
export class UnstorableTraceError extends Error {
  readonly originalBytes: number;

  constructor(traceId: string, originalBytes: number) {
    super(
      `Trace ${traceId} estimated at ${originalBytes} bytes still exceeds ` +
        `the ${MAX_TRACE_DOCUMENT_BYTES}-byte document cap after clipping ` +
        'span content, trace content and span error messages — unstorable ' +
        'as one document; dead-lettered honestly instead of recording a ' +
        'truncation that never reached the store.',
    );
    this.name = 'UnstorableTraceError';
    this.originalBytes = originalBytes;
  }
}

/**
 * Pre-insert size guard (audit B-3): estimates the document's serialized
 * size and, above the cap, replaces span content (then trace-level
 * content, then span error messages — each pass only while the
 * re-estimate still reads over the cap) with truncation markers. Tokens
 * and costs are UNTOUCHED — they come from counts, not content — so the
 * price stamp is exactly what it would have been. A document that stays
 * over the cap after every pass is reported `unstorable` — never
 * silently inserted, never falsely recorded as stored-but-clipped.
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
  let clippedBytes = estimateBytes(clipped);

  if (clippedBytes > MAX_TRACE_DOCUMENT_BYTES) {
    clipped = {
      ...clipped,
      input: marker(trace.input),
      output: marker(trace.output),
    };
    clippedBytes = estimateBytes(clipped);
  }

  // re-audit 2026-08 (sync item 4): the bulk is not always in
  // input/output — span error messages can carry it (huge stack dumps ×
  // many spans). errorMessage is a plain string field, so its marker is a
  // string, not a TruncatedContent object.
  if (clippedBytes > MAX_TRACE_DOCUMENT_BYTES) {
    clipped = {
      ...clipped,
      spans: clipped.spans.map((span) =>
        span.errorMessage === undefined
          ? span
          : {
              ...span,
              errorMessage: `[truncated ${estimateBytes({
                content: span.errorMessage,
              })} bytes]`,
            },
      ),
    };
    clippedBytes = estimateBytes(clipped);
  }

  return {
    trace: clipped,
    truncated: true,
    unstorable: clippedBytes > MAX_TRACE_DOCUMENT_BYTES,
    originalBytes,
  };
};
