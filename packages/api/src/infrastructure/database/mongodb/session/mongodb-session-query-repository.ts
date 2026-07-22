import { Document } from 'mongodb';
import { SessionQueryRepository } from '../../../../application/interfaces/session-query-repository.js';
import { SessionListFilters } from '../../../../domain/useCases/list-sessions-use-case.js';
import { SessionDetail } from '../../../../domain/useCases/get-session-detail-use-case.js';
import { SessionSummaryModel } from '../../../../domain/models/session-model.js';
import { Paginated, Pagination } from '../../../../domain/models/pagination.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * Sessions are a DERIVED read-model (T11): GROUP BY sessionId over stored
 * traces, computed at read time. Aggregates close by construction — the
 * session cost is the exact sum of member stamped costs, no parallel path.
 */
const groupStages: Document[] = [
  // Traces without sessionId belong to no conversation: /traces shows them,
  // /sessions never does.
  { $match: { sessionId: { $type: 'string' } } },
  // Tiebreaker keeps $first-derived fields deterministic when the earliest
  // traces share the same startedAt (same order as the session chain).
  { $sort: { startedAt: 1, traceId: 1 } },
  {
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
      startedAt: { $first: '$startedAt' },
      agent: { $first: '$agent' },
      domain: { $first: '$domain' },
      subdomain: { $first: '$subdomain' },
      lastActivityAt: { $max: '$finishedAt' },
    },
  },
  {
    $addFields: {
      sessionId: '$_id',
      status: { $cond: [{ $gt: ['$errorCount', 0] }, 'error', 'ok'] },
    },
  },
];

const toSummary = (document: Document): SessionSummaryModel => ({
  sessionId: document.sessionId,
  agent: document.agent ?? undefined,
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
    const [result] = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        ...groupStages,
        { $match: buildSessionLevelMatch(filters) },
        { $sort: { startedAt: -1, sessionId: 1 } },
        {
          $facet: {
            items: [
              { $skip: (pagination.page - 1) * pagination.pageSize },
              { $limit: pagination.pageSize },
            ],
            total: [{ $count: 'count' }],
          },
        },
      ])
      .toArray();

    return {
      items: (result?.items ?? []).map(toSummary),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: result?.total[0]?.count ?? 0,
    };
  }

  async findSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const [summaryDocument] = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        { $match: { sessionId } },
        ...groupStages.slice(1),
      ])
      .toArray();

    if (!summaryDocument) {
      return null;
    }

    // Each trace carries its own input/output (transcript); spans are
    // detail-only and projected out of the chain read (decision 47).
    const chain = (await MongoDb.getCollection(TRACES_COLLECTION)
      .find({ sessionId }, { projection: { spans: 0 } })
      .sort({ startedAt: 1, traceId: 1 })
      .toArray()) as unknown as TraceModel[];

    return { summary: toSummary(summaryDocument), chain };
  }
}
