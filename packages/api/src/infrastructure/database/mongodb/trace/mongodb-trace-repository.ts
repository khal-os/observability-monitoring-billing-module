import {
  PendingStamp,
  TraceAttribution,
  TraceRepository,
} from '../../../../application/interfaces/trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { deriveUnclassified } from '../../../../application/useCases/syncTraces/trace-mapper.js';
import { MongoDb } from '../mongo-db.js';

export const TRACES_COLLECTION = 'traces';

/**
 * Storage convention: OPTIONAL FIELDS ARE STORED AS NULL, never absent —
 * every document shows the full schema in the DB. The mapper names every
 * optional key (undefined values) and the BSON serializer turns undefined
 * into null at write time. A pending_price trace therefore shows
 * `totalCostMicrocents: null` — cost OPEN, still never R$ 0 (invariant 2).
 */
export class MongoDbTraceRepository implements TraceRepository {
  async insertIfAbsent(trace: TraceModel): Promise<'inserted' | 'skipped'> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    const existing = await traces.findOne({ traceId: trace.traceId });

    if (existing) {
      return 'skipped';
    }

    // One trace = one document (decision 47): the write is atomic, so the
    // old commit-marker/partial-leftover dance is gone by construction.
    await traces.insertOne({ ...trace });

    return 'inserted';
  }

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<void> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const set: Record<string, unknown> = {};

    if (attribution.agent !== undefined) {
      // Canonical block: version/instance always present (null when absent).
      set['agent'] = {
        id: attribution.agent.id,
        version: attribution.agent.version ?? null,
        instance: attribution.agent.instance ?? null,
      };
    }

    for (const field of ['model', 'domain', 'subdomain'] as const) {
      if (attribution[field] !== undefined) {
        set[field] = attribution[field];
      }
    }

    if (Object.keys(set).length > 0) {
      await traces.updateOne({ traceId }, { $set: set });
    }

    // The unclassified flag is derived from the MERGED document, so a
    // stored correction is never re-flagged by a payload lacking the field
    // and a flag is never cleared while the stored value is still absent.
    const stored = await traces.findOne({ traceId });

    if (!stored) {
      return;
    }

    const unclassified = deriveUnclassified({
      agentId: (stored['agent'] as { id?: string } | null)?.id ?? undefined,
      model: (stored['model'] as string | null) ?? undefined,
    });

    await traces.updateOne(
      { traceId },
      { $set: { unclassified: unclassified ?? null } },
    );
  }

  async stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
  ): Promise<'stamped' | 'skipped'> {
    // The pricingStatus guard makes stamped traces immutable here by
    // construction (invariant 1): only a still-pending trace can match.
    const result = await MongoDb.getCollection(TRACES_COLLECTION).updateOne(
      { traceId, pricingStatus: 'pending_price' },
      {
        $set: {
          pricingStatus: 'stamped',
          stampedCosts: stamp.stampedCosts,
          totalCostMicrocents: stamp.totalCostMicrocents,
          stampedAt: stamp.stampedAt,
          pendingPrice: null,
        },
      },
    );

    return result.matchedCount > 0 ? 'stamped' : 'skipped';
  }

  async findPendingPrice(): Promise<TraceModel[]> {
    const documents = await MongoDb.getCollection(TRACES_COLLECTION)
      .find({ pricingStatus: 'pending_price' })
      .sort({ startedAt: 1 })
      .toArray();

    return documents as unknown as TraceModel[];
  }
}
