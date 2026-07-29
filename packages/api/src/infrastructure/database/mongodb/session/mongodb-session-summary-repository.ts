import { Document } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';
import {
  sessionOnlyMatch,
  sessionSummaryStages,
} from './session-summary-pipeline.js';

export const SESSION_SUMMARIES_COLLECTION = 'session_summaries';

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
 * Single-writer assumption, same as the filter cube: two concurrent
 * recomputes of one session both write a full exact snapshot, so the
 * worst interleaving is a briefly stale summary healed by the next
 * touch, never a corrupted one.
 */
export class MongoDbSessionSummaryRepository {
  async recompute(sessionId: string): Promise<void> {
    const [summary] = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([{ $match: { sessionId } }, ...sessionSummaryStages])
      .toArray();

    const summaries = MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION);

    if (!summary) {
      await summaries.deleteOne({ _id: sessionId } as never);

      return;
    }

    await summaries.replaceOne({ _id: sessionId } as never, summary, {
      upsert: true,
    });
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
