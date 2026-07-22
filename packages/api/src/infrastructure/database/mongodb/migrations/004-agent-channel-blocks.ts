import { Migration } from '../helpers/migration-runner.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * Agents and the omni channel are horizontally scaled, versioned
 * components: traces now denormalize `agent {id, version, instance}` and
 * `channel {type, version, instance}` as point-in-time facts.
 *
 * Reshapes already-stored traces (attribution-level rewrite only — price
 * stamps are untouched, invariant 1) and repoints the query indexes.
 * Idempotent: the filters only match documents still in the old shape.
 */
export const agentChannelBlocks: Migration = {
  id: '004-agent-channel-blocks',

  async run(db) {
    const traces = db.collection(TRACES_COLLECTION);

    await traces.updateMany({ agentId: { $type: 'string' } }, [
      { $set: { agent: { id: '$agentId' } } },
      { $unset: 'agentId' },
    ]);

    await traces.updateMany({ channel: { $type: 'string' } }, [
      { $set: { channel: { type: '$channel' } } },
    ]);

    try {
      await traces.dropIndex('agentId_1_startedAt_-1');
    } catch {
      // Index absent on fresh databases — nothing to drop.
    }

    await traces.createIndex({ 'agent.id': 1, startedAt: -1 });
    await traces.createIndex({ 'channel.type': 1, startedAt: -1 });
  },
};
