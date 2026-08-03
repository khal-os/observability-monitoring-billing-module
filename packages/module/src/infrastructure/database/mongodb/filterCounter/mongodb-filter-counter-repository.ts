import { ClientSession, Document } from 'mongodb';
import { FilterCounterDims } from '../../../../domain/models/filter-counter-model.js';
import { MongoDb } from '../mongo-db.js';
import {
  TRACES_COLLECTION,
  TRACE_FILTER_COUNTERS_COLLECTION,
} from '../collections.js';
import { filterCounterStages } from './filter-counter-pipeline.js';

const tupleFilter = (dims: FilterCounterDims): Document => ({
  day: dims.day,
  domain: dims.domain,
  subdomain: dims.subdomain,
  type: dims.type,
  agentId: dims.agentId,
  channelType: dims.channelType,
  status: dims.status,
});

/**
 * Write side of the facet cube (decision 77). The trace repository calls
 * increment/applyDelta INSIDE the same transaction as its own writes
 * (decision 81): trace and count commit or abort together, so the old
 * crash-between-two-writes drift (a lost increment was wrong FOREVER —
 * retried batches see 'skipped' and never re-increment) cannot happen.
 * `rebuildFromTraces` remains for restored deployments; billing never
 * reads the cube (invariant 3 keeps it on the stamps).
 */
export class MongoDbFilterCounterRepository {
  async increment(
    dims: FilterCounterDims,
    session?: ClientSession,
  ): Promise<void> {
    await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION).updateOne(
      tupleFilter(dims),
      { $inc: { count: 1 } },
      { upsert: true, session },
    );
  }

  /** Attribution correction moved a trace across tuples (invariant 7). */
  async applyDelta(
    before: FilterCounterDims,
    after: FilterCounterDims,
    session?: ClientSession,
  ): Promise<void> {
    const counters = MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION);

    // Zero-count leftovers are fine: the facet read filters count > 0.
    // The decrement itself is guarded on count > 0 (audit C-7.4): on a
    // drifted cube (missing or already-zero tuple) it no-ops instead of
    // going negative — a negative tuple would DEFLATE facet sums, since
    // it participates in $sum before the read's count > 0 post-filter.
    await counters.updateOne(
      { ...tupleFilter(before), count: { $gt: 0 } },
      { $inc: { count: -1 } },
      { session },
    );
    await counters.updateOne(
      tupleFilter(after),
      { $inc: { count: 1 } },
      { upsert: true, session },
    );
  }

  /**
   * Full recompute from the traces collection — backfill for restored/
   * pre-existing deployments and drift repair. $out swaps the whole
   * collection atomically and preserves the target's indexes.
   */
  async rebuildFromTraces(): Promise<number> {
    await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate(
        [...filterCounterStages, { $out: TRACE_FILTER_COUNTERS_COLLECTION }],
        { allowDiskUse: true },
      )
      .toArray();

    return MongoDb.getCollection(
      TRACE_FILTER_COUNTERS_COLLECTION,
    ).countDocuments();
  }
}
