import { Document } from 'mongodb';

/**
 * THE facet-cube tuple derivation, stated once (decision 77): how a trace
 * document maps to its dimension tuple. Consumed by the full rebuild
 * ($group over the traces collection) and mirrored by the incremental
 * write path (domain `toFilterCounterDims`) — the repository's identity
 * test asserts the two stay byte-equal, so the cube can never drift by
 * construction. Same pattern as the sessions read-model
 * (session-summary-pipeline.ts).
 */
export const filterCounterStages: Document[] = [
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
];
