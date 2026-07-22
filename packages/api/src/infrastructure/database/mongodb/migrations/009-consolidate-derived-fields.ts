import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * Decision 51: traces are immutable snapshots, so derived fields are
 * consolidated in the document at write time and readers never re-derive
 * them. Backfills the two consolidated fields on documents ingested
 * before the convention:
 *
 *   - trace.tokensTotal  = sum of the four token-type counts
 *   - span.offsetMs      = span.startedAt - trace.startedAt (ms)
 *
 * Attribution-level rewrite only — price stamps keep their exact values.
 * Idempotent: only touches documents missing the fields.
 */
export const consolidateDerivedFields: Migration = {
  id: '009-consolidate-derived-fields',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await traces.updateMany({ tokensTotal: { $exists: false } }, [
      {
        $set: {
          tokensTotal: {
            $add: [
              { $ifNull: ['$tokens.input', 0] },
              { $ifNull: ['$tokens.output', 0] },
              { $ifNull: ['$tokens.cache_read', 0] },
              { $ifNull: ['$tokens.cache_write', 0] },
            ],
          },
        },
      },
    ]);

    await traces.updateMany({ 'spans.offsetMs': { $exists: false }, spans: { $ne: [] } }, [
      {
        $set: {
          spans: {
            $map: {
              input: '$spans',
              as: 'span',
              in: {
                $mergeObjects: [
                  '$$span',
                  {
                    offsetMs: {
                      $subtract: ['$$span.startedAt', '$startedAt'],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
  },
};
