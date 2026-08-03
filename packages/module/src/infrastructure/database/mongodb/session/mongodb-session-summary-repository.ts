import { Document } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import {
  SESSION_SUMMARIES_COLLECTION,
  TRACES_COLLECTION,
} from '../collections.js';
import {
  sessionOnlyMatch,
  sessionSummaryStages,
} from './session-summary-pipeline.js';
import { retryOnceOnDuplicateKey } from '../helpers/retry-once-on-duplicate-key.js';

/**
 * Materialized sessions read-model (decision 80): one small document per
 * session, maintained at write time so GET /sessions is an indexed find
 * instead of a full-history group per request.
 *
 * Maintenance strategy is RECOMPUTE-ON-TOUCH, not incremental deltas: any
 * write that touches a session (insert, stamp, attribution change)
 * re-derives that ONE session's summary from its traces — an indexed
 * per-session aggregation, bounded by session size. Exact by
 * construction (the recompute reads the store AFTER the write, through
 * the same pipeline the live detail read uses), and self-healing: a
 * crash between the trace write and the recompute leaves that session
 * stale only until its next touch — or the rebuild job. The classic
 * incremental-counter drift (a lost delta is wrong FOREVER) cannot
 * happen here.
 *
 * There is NO single-writer assumption (audit B-6): the ingestion worker
 * and a manual `make sync` are a legal combination, so two recomputes of
 * one session can overlap. The recompute is a single server-side $merge
 * pipeline — aggregate and write happen inside ONE aggregation command —
 * which SHRANK the lost-update window from a client round-trip gap to
 * the intra-command gap between the aggregation's read snapshot and its
 * merge write; it did NOT eliminate it. Two overlapping recomputes can
 * still, in principle, land with the earlier read snapshot writing last
 * — the healer for that residue is the same one as for a crash: the next
 * touch of the session, or the rebuild job. Two concurrent first-touch
 * $merge inserts of the same _id can also race into E11000; one retry
 * settles it (the second pass finds the document and replaces).
 */
export class MongoDbSessionSummaryRepository {
  async recompute(sessionId: string): Promise<void> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // THE derivation (decision 80): same shared stages as the rebuild and
    // the live detail read — only the sink differs.
    const merge = () =>
      traces
        .aggregate([
          { $match: { sessionId } },
          ...sessionSummaryStages,
          {
            $merge: {
              into: SESSION_SUMMARIES_COLLECTION,
              on: '_id',
              whenMatched: 'replace',
              whenNotMatched: 'insert',
            },
          },
        ])
        .toArray();

    // Wave review: the same first-touch race the sync's trails hit, so
    // the same house helper — not a third hand-rolled copy of it.
    await retryOnceOnDuplicateKey(merge);

    // $merge writes nothing for an empty input, so a session with no
    // traces left would keep its summary forever. Defensive today (the
    // archive never deletes traces), kept for parity with the rebuild:
    // a summary must never outlive its session.
    const hasTraces = await traces.countDocuments({ sessionId }, { limit: 1 });

    if (hasTraces === 0) {
      await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION).deleteOne({
        _id: sessionId,
      } as never);
    }
  }

  /**
   * Full rebuild from the traces — the job is the source of truth for the
   * collection (same contract as the filter cube, decision 77): required
   * once on restored/pre-existing deployments, and heals any session left
   * stale by a crash between a trace write and its recompute. $out swaps
   * the collection atomically.
   */
  async rebuildFromTraces(): Promise<void> {
    await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate(
        [
          { $match: sessionOnlyMatch },
          ...sessionSummaryStages,
          { $out: SESSION_SUMMARIES_COLLECTION },
        ],
        { allowDiskUse: true },
      )
      .toArray();
  }
}

/** Escape hatch for tests asserting the materialized shape directly. */
export const readSessionSummary = async (
  sessionId: string,
): Promise<Document | null> =>
  MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION).findOne({
    _id: sessionId,
  } as never);
