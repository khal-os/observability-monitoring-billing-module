import { Document } from 'mongodb';
import { SessionQueryRepository } from '../../../../application/interfaces/session-query-repository.js';
import { SessionListFilters } from '../../../../domain/useCases/list-sessions-use-case.js';
import { SessionDetail } from '../../../../domain/useCases/get-session-detail-use-case.js';
import { SessionFilterOptions } from '../../../../domain/useCases/list-session-filter-options-use-case.js';
import { SessionSummaryModel } from '../../../../domain/models/session-model.js';
import {
  MAX_PAGINATION_SKIP,
  Paginated,
  Pagination,
} from '../../../../domain/models/pagination.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';
import { sessionSummaryStages } from './session-summary-pipeline.js';
import { SESSION_SUMMARIES_COLLECTION } from './mongodb-session-summary-repository.js';

/**
 * Sessions are a DERIVED read-model (T11), now MATERIALIZED (decision
 * 80): the list reads `session_summaries` — one small document per
 * session, maintained by recompute-on-touch at ingestion and rebuildable
 * from the traces — through plain indexed finds (migration 014). The
 * money shown per session stays the exact sum of member stamped costs by
 * construction: the summary is always produced by the SAME pipeline the
 * live detail read uses, over the traces themselves.
 *
 * The detail read stays LIVE-derived: it is one indexed per-session
 * aggregation, and the money-bearing drill-down should never be one
 * staleness window away from the store.
 */

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

const buildSessionMatch = (filters: SessionListFilters): Document => {
  const match: Document = {};

  // QA17: period filter anchors on the session's START time — a
  // materialized field here, so the filter is a plain indexed range.
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
    const summaries = MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION);
    const filter = buildSessionMatch(filters);

    const [items, rawTotal] = await Promise.all([
      summaries
        .find(filter)
        .sort({ startedAt: -1, sessionId: 1 })
        .skip((pagination.page - 1) * pagination.pageSize)
        .limit(pagination.pageSize)
        .toArray(),
      // Capped counting, same horizon as traces (decision 77/79).
      summaries.countDocuments(filter, { limit: MAX_PAGINATION_SKIP + 1 }),
    ]);

    const totalCapped = rawTotal > MAX_PAGINATION_SKIP;

    return {
      items: items.map(toSummary),
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: totalCapped ? MAX_PAGINATION_SKIP : rawTotal,
      totalCapped,
    };
  }

  async findSessionFilterOptions(
    filters: SessionListFilters,
  ): Promise<SessionFilterOptions> {
    // One $facet pass over the materialized summaries (decision 80): tiny
    // documents, so counting is cheap at any trace volume. Self-exclusion
    // per field (decision 76 semantics): each facet applies every filter
    // EXCEPT its own, so a selected dropdown keeps listing alternatives.
    const withoutAgent: SessionListFilters = { ...filters, agentId: undefined };
    const withoutStatus: SessionListFilters = { ...filters, status: undefined };

    const [result] = await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION)
      .aggregate([
        {
          $facet: {
            agents: [
              { $match: { ...buildSessionMatch(withoutAgent), 'agent.id': { $type: 'string' } } },
              { $group: { _id: '$agent.id', count: { $sum: 1 } } },
              { $sort: { _id: 1 } },
            ],
            statuses: [
              { $match: buildSessionMatch(withoutStatus) },
              { $group: { _id: '$status', count: { $sum: 1 } } },
              { $sort: { _id: 1 } },
            ],
          },
        },
      ])
      .toArray();

    const toOptions = (rows: Document[] | undefined) =>
      (rows ?? []).map((row) => ({
        value: row._id as string,
        count: row.count as number,
      }));

    return {
      agents: toOptions(result?.agents),
      statuses: toOptions(result?.statuses),
    };
  }

  async findSessionDetail(sessionId: string): Promise<SessionDetail | null> {
    const [summaryDocument] = await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([{ $match: { sessionId } }, ...sessionSummaryStages])
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
