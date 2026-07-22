import { Document } from 'mongodb';
import { Migration } from '../helpers/migration-runner.js';
import { LEGACY_TRACE_CONTENTS_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * `spanContents` was an artifact of the old two-collection layout (span
 * metadata apart from span payloads). With spans embedded in the content
 * document, each span now carries its OWN input/output. Merges the legacy
 * parallel array into the spans and drops it. Idempotent: only documents
 * still holding `spanContents` are touched; stamps live elsewhere and are
 * untouched.
 */
export const mergeSpanContents: Migration = {
  id: '007-merge-span-contents',

  async run(db) {
    const contents = db.collection(LEGACY_TRACE_CONTENTS_COLLECTION);

    const pending = contents.find({ spanContents: { $exists: true } });

    for await (const content of pending) {
      const payloadBySpanId = new Map<string, Document>(
        ((content['spanContents'] ?? []) as Document[]).map((spanContent) => [
          spanContent['spanId'] as string,
          spanContent,
        ]),
      );

      const mergedSpans = ((content['spans'] ?? []) as Document[]).map(
        (span) => ({
          ...span,
          input: payloadBySpanId.get(span['spanId'] as string)?.['input'] ?? null,
          output:
            payloadBySpanId.get(span['spanId'] as string)?.['output'] ?? null,
        }),
      );

      await contents.updateOne(
        { _id: content._id },
        { $set: { spans: mergedSpans }, $unset: { spanContents: '' } },
      );
    }
  },
};
