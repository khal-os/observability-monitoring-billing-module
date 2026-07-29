import { Document } from 'mongodb';

/**
 * THE session derivation, stated once (decision 80): GROUP BY sessionId
 * over stored traces. Consumed by three readers that must never diverge —
 * the per-session recompute (write-time maintenance of the materialized
 * summaries), the full rebuild job, and the live session-detail read.
 * Session cost stays the exact sum of member stamped costs by
 * construction: every path is THIS pipeline over the traces themselves.
 */

// Traces without sessionId belong to no conversation: /traces shows them,
// /sessions never does.
export const sessionOnlyMatch: Document = { sessionId: { $type: 'string' } };

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
    // Earliest trace's fields with a deterministic (startedAt, traceId)
    // tiebreak — $top needs no pre-sort, so no blocking stage at any size.
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

/** Group + unpack + drop the scratch field — yields the summary shape. */
export const sessionSummaryStages: Document[] = [
  summaryGroupStage,
  unpackStage,
  { $unset: 'first' },
];
