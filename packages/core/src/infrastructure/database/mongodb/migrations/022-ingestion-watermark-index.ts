import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * audit F-3: `ingestionWatermark` is `$match {startedAt: [month window]}`
 * + `$group {$max: '$ingestedAt'}` — and `ingestedAt` was in NO index, so
 * the planner FETCHED every document of the open month (full transcript +
 * spans, ~3.4 GB per million traces) to read one timestamp each, on EVERY
 * `GET /billing/summary` and inside every `make billing-close`. This is a
 * SECOND full-month document pass on the summary path, distinct from the
 * accepted fetchUsageRecords remainder — and unlike it, an index removes
 * it entirely: measured `docsExamined 3000 → 0` (PROJECTION_COVERED).
 */
export const ingestionWatermarkIndex: Migration = {
  id: '022-ingestion-watermark-index',

  async run(db) {
    await db
      .collection(TRACES_COLLECTION)
      .createIndex({ startedAt: 1, ingestedAt: 1 });
  },
};
