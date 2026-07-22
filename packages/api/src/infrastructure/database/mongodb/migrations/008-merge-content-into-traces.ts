import { Migration } from '../helpers/migration-runner.js';
import {
  LEGACY_TRACE_CONTENTS_COLLECTION,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';

/**
 * Decision 47: one trace = one self-contained document. Merges the legacy
 * content documents (input/output + spans) into their traces and drops the
 * collection. Trade-off accepted knowingly: aggregations load full
 * documents — revisit at QA15 sizing. Stamps untouched; idempotent (only
 * traces still missing the merged fields are written).
 */
export const mergeContentIntoTraces: Migration = {
  id: '008-merge-content-into-traces',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);
    const legacyContents = db.collection(LEGACY_TRACE_CONTENTS_COLLECTION);

    for await (const content of legacyContents.find()) {
      await traces.updateOne(
        { traceId: content['traceId'], spans: { $exists: false } },
        {
          $set: {
            input: content['input'] ?? null,
            output: content['output'] ?? null,
            spans: content['spans'] ?? [],
          },
        },
      );
    }

    // Traces that never had a content document still get the full schema.
    await traces.updateMany(
      { spans: { $exists: false } },
      { $set: { input: null, output: null, spans: [] } },
    );

    await legacyContents.drop().catch(() => undefined);
  },
};
