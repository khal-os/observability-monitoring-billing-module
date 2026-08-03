import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../collections.js';

/**
 * re-audit: `countQuarantined` had NO supporting index. Its predicate is
 *
 *   { startedAt: { $gte: monthStart, $lt: monthEnd },
 *     'billingQuarantine.reason': { $exists: true },
 *     'billingQuarantine.absorbedInSnapshotVersion': { $exists: false } }
 *
 * and the only index it could ride was 003's `{startedAt: -1}` — so both
 * quarantine predicates were residual filters over the WHOLE month: FETCH
 * ← IXSCAN with totalDocsExamined = every trace of the month. Trace
 * documents embed the full transcript and every span (decision 47,
 * ~3.4 GB per million traces measured in QA15), and `/billing/bills` fires
 * one call per month through Promise.all — so a request re-read every
 * closed month's traces, defeating the C-7.1 bound ("closed history is
 * served from period docs + snapshots, never re-scanned") and invariant 8
 * for `/billing/summary`.
 *
 * Plan reasoning for the shape below:
 * - `partialFilterExpression: {'billingQuarantine.reason': {$exists: true}}`
 *   is the query's own predicate VERBATIM, which is what makes the planner
 *   qualify the partial index; the index then holds only quarantined
 *   traces — a handful, not the month;
 * - `startedAt` is the single key because the month window is the only
 *   RANGE in the predicate, so it must be the scanned bound (leading with
 *   the quarantine field would buy nothing: inside the partial index every
 *   document already satisfies it);
 * - `absorbedInSnapshotVersion: {$exists: false}` stays a residual FETCH
 *   filter — `$exists: false` is not a legal partialFilterExpression
 *   operator, and the candidate set it filters is already only the month's
 *   quarantined traces.
 * Measured on the production index set (20 000 traces, 4 quarantined):
 * totalKeysExamined/totalDocsExamined 20 000 → 4.
 *
 * The explicit name is required: the key `{startedAt: 1}` with different
 * options would otherwise collide by name with a plain `startedAt_1`.
 */
export const quarantineIndex: Migration = {
  id: '021-quarantine-index',

  async run(db) {
    await db.collection(TRACES_COLLECTION).createIndex(
      { startedAt: 1 },
      {
        name: 'quarantine_startedAt',
        partialFilterExpression: {
          'billingQuarantine.reason': { $exists: true },
        },
      },
    );
  },
};
