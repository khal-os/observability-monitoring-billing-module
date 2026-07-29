import { Document } from 'mongodb';
import { SessionQueryRepository } from '../../../../application/interfaces/session-query-repository.js';
import { SessionListFilters } from '../../../../domain/useCases/list-sessions-use-case.js';
import { SessionDetail } from '../../../../domain/useCases/get-session-detail-use-case.js';
import { SessionSummaryModel } from '../../../../domain/models/session-model.js';
import {
  MAX_PAGINATION_SKIP,
  Paginated,
  Pagination,
} from '../../../../domain/models/pagination.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * Sessions are a DERIVED read-model (T11): GROUP BY sessionId over stored
 * traces, computed at read time. Aggregates close by construction — the
 * session cost is the exact sum of member stamped costs, no parallel path.
 *
 * 1M-scale shape (decision 79): the old pipeline blocking-sorted the whole
 * collection ascending before grouping — a direction no index serves
 * (migration 013's {startedAt: -1, traceId: 1} reversed flips BOTH keys),
 * so at 1M docs it exceeded the 100 MB stage limit and the endpoint 500'd.
 * The $top accumulator picks the earliest trace's fields with the same
 * (startedAt, traceId) tiebreak WITHOUT any pre-sort; allowDiskUse backs
 * the group/sort as the collection grows; totals are capped like the
 * traces list. A materialized sessions collection remains the real
 * follow-up — this keeps the derived pipeline alive until then.
 */
const summaryGroupStage: Document = {
  $group: {
    _id: '$sessionId',
    traceCount: { $sum: 1 },
    errorCount: {
      $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] },
    },
    totalDurationMs: { $sum: '$durationMs' },
    tokensInput: { $sum: { $ifNull: ['$tokens.input', 0] } },
    tokensOutput: { $sum: { $ifNull: ['$tokens.output', 0] } },
    tokensCacheRead: { $sum: { $ifNull: ['$tokens.cache_read', 0] } },
    tokensCacheWrite: { $sum: { $ifNull: ['$tokens.cache_write', 0] } },
    // Sum of STAMPED costs only. Pending traces contribute nothing here
    // and are surfaced through pendingPriceCount — never as R$ 0.
    stampedCostMicrocents: { $sum: { $ifNull: ['$totalCostMicrocents', 0] } },
    pendingPriceCount: {
      $sum: {
        $cond: [{ $eq: ['$pricingStatus', 'pending_price'] }, 1, 0],
      },
    },
    // Earliest trace's fields, deterministic tiebreak — replaces the old
    // whole-collection pre-sort (same semantics, no blocking stage).
    first: {
      $top: {
        sortBy: { startedAt: 1, traceId: 1 },
        output: {
          startedAt: '$startedAt',
          agent: '$agent',
          userId: '$userId',
          domain: '$domain',
          subdomain: '$subdomain',
        },
      },
    },
    lastActivityAt: { $max: '$finishedAt' },
  },
};

const unpackStage: Document = {
  $addFields: {
    sessionId: '$_id',
    startedAt: '$first.startedAt',
    agent: '$first.agent',
    userId: '$first.userId',
    domain: '$first.domain',
    subdomain: '$first.subdomain',
    status: { $cond: [{ $gt: ['$errorCount', 0] }, 'error', 'ok'] },
  },
};

// Traces without sessionId belong to no conversation: /traces shows them,
// /sessions never does.
const sessionOnlyMatch: Document = { sessionId: { $type: 'string' } };

/**
 * A session-detail chain has no product-defined bound, and each trace
 * carries its full transcript — a runaway bot loop would otherwise
 * assemble a response of hundreds of MB in Node. The truncation is
 * NEVER silent: the flag travels to the client (decision 79).
 */
export const SESSION_CHAIN_LIMIT = 1_000;

const toSummary = (document: Document): SessionSummaryModel => ({
  sessionId: document.sessionId,
  agent: document.agent ?? undefined,
  userId: document.userId ?? undefined,
  domain: document.domain ?? undefined,
  subdomain: document.subdomain ?? undefined,
  traceCount: document.traceCount,
  status: document.status,
  totalDurationMs: document.totalDurationMs,
  tokens: {
    input: document.tokensInput,
    output: document.tokensOutput,
    cache_read: document.tokensCacheRead,
    cache_write: document.tokensCacheWrite,
  },
  stampedCostMicrocents: document.stampedCostMicrocents,
  pendingPriceCount: document.pendingPriceCount,
  startedAt: document.startedAt,
  lastActivityAt: document.lastActivityAt,
});

const buildSessionLevelMatch = (filters: SessionListFilters): Document => {
  const match: Document = {};

  // QA17: period filter anchors on the session's START time.
  if (filters.from || filters.to) {
    match['startedAt'] = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lt: filters.to } : {}),
    };
  }

  if (filters.agentId) match['agent.id'] = filters.agentId;
  if (filters.status) match['status'] = filters.status;

  return match;
};

export class MongoDbSessionQueryRepository implements SessionQueryRepository {
  async findSessions(
    filters: SessionListFilters,
    pagination: Pagination,
  ): Promise<Paginated<SessionSummaryModel>> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    // Two-phase narrowing for period filters: a session whose TRUE start
    // is in-window necessarily has at least one trace in-window, so the
    // candidate set "sessions ACTIVE in the window" (an indexed startedAt
    // range scan) is a correct superset. Phase 2 groups ONLY those
    // sessions' traces — with COMPLETE sums, since $in selects whole
    // sessions — and the post-group match applies the exact QA17 window,
    // discarding candidates that merely continued into it. No trace-level
    // window filter is sound on its own: it would truncate sums and
    // misdate sessions that started before the window.
    let candidateMatch: Document = sessionOnlyMatch;

    if (filters.from || filters.to) {
      const windowRange = {
        ...(filters.from ? { $gte: filters.from } : {}),
        ...(filters.to ? { $lt: filters.to } : {}),
      };
      const candidates = await traces
        .aggregate(
          [
            { $match: { ...sessionOnlyMatch, startedAt: windowRange } },
            { $group: { _id: '$sessionId' } },
          ],
          { allowDiskUse: true },
        )
        .toArray();

      candidateMatch = {
        sessionId: { $in: candidates.map((document) => document._id) },
      };
    }

    const [result] = await traces
      .aggregate(
        [
          { $match: candidateMatch },
          summaryGroupStage,
          unpackStage,
          { $match: buildSessionLevelMatch(filters) },
          { $sort: { startedAt: -1, sessionId: 1 } },
          {
            $facet: {
              items: [
                { $skip: (pagination.page - 1) * pagination.pageSize },
                { $limit: pagination.pageSize },
              ],
              // Capped counting, same horizon as traces (decision 77/79):
              // exact totals over the grouped set are O(sessions).
              total: [{ $limit: MAX_PAGINATION_SKIP + 1 }, { $count: 'count' }],
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    const rawTotal = result?.total[0]?.count ?? 0;
    const totalCapped = rawTotal > MAX_PAGINATION_SKIP;

    return {
      items: (result?.items ?? []).map(toSummary),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: totalCapped ? MAX_PAGINATION_SKIP : rawTotal,
      totalCapped,
    };
  }

  async findSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const [summaryDocument] = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([{ $match: { sessionId } }, summaryGroupStage, unpackStage])
      .toArray();

    if (!summaryDocument) {
      return null;
    }

    // Each trace carries its own input/output (transcript); spans are
    // detail-only and projected out of the chain read (decision 47).
    const chainDocuments = (await MongoDb.getCollection(TRACES_COLLECTION)
      .find({ sessionId }, { projection: { spans: 0 } })
      .sort({ startedAt: 1, traceId: 1 })
      .limit(SESSION_CHAIN_LIMIT + 1)
      .toArray()) as unknown as TraceModel[];

    const chainTruncated = chainDocuments.length > SESSION_CHAIN_LIMIT;
    const chain = chainTruncated
      ? chainDocuments.slice(0, SESSION_CHAIN_LIMIT)
      : chainDocuments;

    return { summary: toSummary(summaryDocument), chain, chainTruncated };
  }
}
