import { ClientSession, Document } from 'mongodb';
import { FilterCounterDims } from '../../../../domain/models/filter-counter-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

export const TRACE_FILTER_COUNTERS_COLLECTION = 'trace_filter_counters';

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
    await counters.updateOne(
      tupleFilter(before),
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
        [
          {
            $group: {
              _id: {
                day: { $dateTrunc: { date: '$startedAt', unit: 'day' } },
                domain: { $ifNull: ['$domain', null] },
                subdomain: { $ifNull: ['$subdomain', null] },
                type: '$type',
                agentId: { $ifNull: ['$agent.id', null] },
                channelType: '$channel.type',
                status: '$status',
              },
              count: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              day: '$_id.day',
              domain: '$_id.domain',
              subdomain: '$_id.subdomain',
              type: '$_id.type',
              agentId: '$_id.agentId',
              channelType: '$_id.channelType',
              status: '$_id.status',
              count: 1,
            },
          },
          { $out: TRACE_FILTER_COUNTERS_COLLECTION },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    return MongoDb.getCollection(
      TRACE_FILTER_COUNTERS_COLLECTION,
    ).countDocuments();
  }
}
