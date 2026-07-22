import { Migration } from '../helpers/migration-runner.js';
import {
  LEGACY_SPANS_COLLECTION,
  LEGACY_TRACE_CONTENTS_COLLECTION,
} from '../trace/mongodb-trace-repository.js';

/**
 * Spans are consumed ONLY by the trace detail view (product decision), so
 * they move from their own collection into the trace's content document —
 * the detail-only payload. Attribution/store reshape only: price stamps
 * are untouched. Idempotent: only content documents still missing the
 * `spans` field are filled; the legacy collection drop tolerates absence.
 */
export const embedSpans: Migration = {
  id: '006-embed-spans',

  async run(db) {
    const legacySpans = db.collection(LEGACY_SPANS_COLLECTION);
    const contents = db.collection(LEGACY_TRACE_CONTENTS_COLLECTION);

    const pending = contents.find({ spans: { $exists: false } });

    for await (const content of pending) {
      const spans = await legacySpans
        .find({ traceId: content['traceId'] })
        .sort({ startedAt: 1, spanId: 1 })
        .toArray();

      await contents.updateOne(
        { _id: content._id },
        {
          $set: {
            spans: spans.map(({ _id, traceId, ...span }) => span),
          },
        },
      );
    }

    await legacySpans.drop().catch(() => undefined);
  },
};
