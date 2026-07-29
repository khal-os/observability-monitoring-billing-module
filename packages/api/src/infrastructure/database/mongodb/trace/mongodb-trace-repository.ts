import {
  PendingPriceTrace,
  PendingStamp,
  TraceAttribution,
  TraceRepository,
} from '../../../../application/interfaces/trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { ModelRef } from '../../../../domain/models/model-ref.js';
import { toFilterCounterDims } from '../../../../domain/models/filter-counter-model.js';
import { deriveUnclassified } from '../../../../application/useCases/syncTraces/trace-mapper.js';
import { MongoDb } from '../mongo-db.js';
import { MongoDbFilterCounterRepository } from '../filterCounter/mongodb-filter-counter-repository.js';
import { MongoDbSessionSummaryRepository } from '../session/mongodb-session-summary-repository.js';

export const TRACES_COLLECTION = 'traces';

// Lazy: the counter repository imports TRACES_COLLECTION back from this
// module — instantiating at call time keeps the cycle harmless.
let filterCountersInstance: MongoDbFilterCounterRepository | undefined;
const filterCounters = () =>
  (filterCountersInstance ??= new MongoDbFilterCounterRepository());

// Same lazy pattern for the materialized sessions read-model (decision
// 80): every write that touches a session re-derives that session's
// summary — exact by construction, self-healing on the next touch.
let sessionSummariesInstance: MongoDbSessionSummaryRepository | undefined;
const sessionSummaries = () =>
  (sessionSummariesInstance ??= new MongoDbSessionSummaryRepository());

const recomputeSessionOf = async (
  sessionId: string | undefined | null,
): Promise<void> => {
  if (typeof sessionId === 'string') {
    await sessionSummaries().recompute(sessionId);
  }
};

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number }).code === 11000;

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

    // One trace = one document (decision 47) and trace + counter commit
    // or abort TOGETHER (decision 81): the facet cube's exactly-once
    // counting rides the same durability as the insert — a crash can no
    // longer land the trace without its count (which a retried batch,
    // seeing 'skipped', would never repair).
    try {
      await MongoDb.withTransaction(async (session) => {
        await traces.insertOne({ ...trace }, { session });
        await filterCounters().increment(toFilterCounterDims(trace), session);
      });
    } catch (error) {
      // findOne→insertOne is check-then-act: a concurrent ingestor (the
      // worker and a manual `make sync` are a legal combination) can win
      // the race between the two calls. The unique traceId index turns
      // that into E11000 aborting the transaction — which is just
      // "skipped" arriving late, same as the price repo treats it.
      // Anything else propagates.
      if (isDuplicateKey(error)) {
        return 'skipped';
      }

      throw error;
    }

    // Sessions read-model (decision 80) — deliberately OUTSIDE the
    // transaction: recompute-on-touch is self-healing (next touch or
    // rebuild), and keeping the transaction two writes wide keeps it
    // fast and conflict-free.
    await recomputeSessionOf(trace.sessionId);

    return 'inserted';
  }

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<void> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // The whole read-modify-write runs in ONE transaction (decision 81):
    // the before-snapshot, the attribution merge, the counter delta and
    // the unclassified recompute commit or abort together — no partial
    // state, no counter delta applied against a torn document.
    const sessionId = await MongoDb.withTransaction<string | null>(
      async (session) => {
        // Snapshot BEFORE the correction: agent/domain/subdomain are facet
        // cube dimensions, so a correction must move the trace's count from
        // its old tuple to the new one (decision 77).
        const before = (await traces.findOne(
          { traceId },
          { session },
        )) as unknown as (TraceModel & { attributionCorrectedAt?: Date }) | null;

        // Runbook-corrected traces are off-limits to source refreshes
        // (decision 79): the source still carries the value the correction
        // fixed, so refreshing would silently revert it on every re-sync.
        if (!before || before.attributionCorrectedAt) {
          return null;
        }

        const set: Record<string, unknown> = {};

        if (attribution.agent !== undefined) {
          // Canonical block: version/instance always present (null when absent).
          set['agent'] = {
            id: attribution.agent.id,
            version: attribution.agent.version ?? null,
            instance: attribution.agent.instance ?? null,
          };
        }

        if (attribution.model !== undefined) {
          // Canonical block: provider always present (null when unknown).
          set['model'] = {
            id: attribution.model.id,
            provider: attribution.model.provider ?? null,
          };
        }

        for (const field of ['domain', 'subdomain'] as const) {
          if (attribution[field] !== undefined) {
            set[field] = attribution[field];
          }
        }

        if (Object.keys(set).length > 0) {
          await traces.updateOne({ traceId }, { $set: set }, { session });
        }

        // The unclassified flag is derived from the MERGED document, so a
        // stored correction is never re-flagged by a payload lacking the
        // field and a flag is never cleared while the stored value is
        // still absent.
        const stored = await traces.findOne({ traceId }, { session });

        if (!stored) {
          return null;
        }

        const beforeDims = toFilterCounterDims(before);
        const afterDims = toFilterCounterDims(stored as unknown as TraceModel);

        if (JSON.stringify(beforeDims) !== JSON.stringify(afterDims)) {
          await filterCounters().applyDelta(beforeDims, afterDims, session);
        }

        const unclassified = deriveUnclassified({
          agentId: (stored['agent'] as { id?: string } | null)?.id ?? undefined,
          model: (stored['model'] as ModelRef | null) ?? undefined,
        });

        await traces.updateOne(
          { traceId },
          { $set: { unclassified: unclassified ?? null } },
          { session },
        );

        return (stored['sessionId'] as string | null) ?? null;
      },
    );

    // Attribution feeds the session's first-trace block — refresh the
    // materialized summary (decision 80); outside the transaction, same
    // rationale as insertIfAbsent (self-healing by design).
    await recomputeSessionOf(sessionId);
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

    if (result.matchedCount === 0) {
      return 'skipped';
    }

    // The stamp moved this session's cost/pending totals — refresh the
    // materialized summary (decision 80).
    const stamped = await MongoDb.getCollection(TRACES_COLLECTION).findOne(
      { traceId },
      { projection: { _id: 0, sessionId: 1 } },
    );

    await recomputeSessionOf(stamped?.['sessionId'] as string | null);

    return 'stamped';
  }

  async findPendingPrice(): Promise<PendingPriceTrace[]> {
    // Slim projection (decision 79): re-stamping needs four small fields;
    // the embedded input/output/spans (decision 47) stay in the store —
    // the sweep runs inside the ingestion worker and must stay bounded
    // even when a new unpriced model has accumulated a day of traffic.
    const documents = await MongoDb.getCollection(TRACES_COLLECTION)
      .find(
        { pricingStatus: 'pending_price' },
        { projection: { _id: 0, traceId: 1, model: 1, startedAt: 1, tokens: 1 } },
      )
      .sort({ startedAt: 1 })
      .toArray();

    return documents as unknown as PendingPriceTrace[];
  }
}
