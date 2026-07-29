import { MongoDb } from '../mongo-db.js';
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from './mongodb-trace-repository.js';
import {
  makeContractStampedCosts,
  makeContractTrace,
  runTraceRepositoryContract,
  TraceRepositoryHarness,
} from '../../../../application/interfaces/trace-repository.contract.js';

/**
 * The Mongo adapter proves the SHARED TraceRepository contract — the
 * invariant tests themselves live with the port
 * (data/interfaces/trace-repository.contract.ts), written once for every
 * backend. Only the harness below is Mongo-aware.
 */
describe('MongoDbTraceRepository', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  const makeHarness = (): TraceRepositoryHarness => ({
    repository: new MongoDbTraceRepository(),

    readTrace: (traceId) =>
      MongoDb.getCollection(TRACES_COLLECTION).findOne({ traceId }),

    // Open-period runbook correction applied straight to the store.
    applyRawCorrection: async (traceId, agentId) => {
      // The runbook convention (decision 79): a manual correction ALWAYS
      // stamps attributionCorrectedAt — it is what shields the corrected
      // trace from being reverted by the next source refresh.
      await MongoDb.getCollection(TRACES_COLLECTION).updateOne(
        { traceId },
        {
          $set: {
            agent: { id: agentId },
            attributionCorrectedAt: new Date(),
          },
          $unset: { unclassified: '' },
        },
      );
    },

    reset: async () => {
      await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    },
  });

  runTraceRepositoryContract(makeHarness);

  // MONGO-SPECIFIC storage convention, beyond the port contract: optional
  // fields are stored as EXPLICIT null, never absent (uniform full-schema
  // documents — see mongodb-trace-repository.ts header and migration 005).
  // The shared contract normalizes `?? null` on purpose, so the convention
  // is pinned here, adapter-side.
  describe('Mongo storage convention: cleared fields stay present as explicit null', () => {
    beforeEach(async () => {
      await makeHarness().reset();
    });

    it('MUST keep unclassified PRESENT with value null after a clearing correction', async () => {
      const harness = makeHarness();

      await harness.repository.insertIfAbsent(
        makeContractTrace({
          agent: undefined,
          unclassified: { reasons: ['missing agentId'] },
        }),
      );
      await harness.repository.updateAttribution('trace-001', {
        agent: { id: 'agent-atendimento' },
      });

      const doc = await MongoDb.getCollection(TRACES_COLLECTION).findOne({
        traceId: 'trace-001',
      });

      expect(Object.hasOwn(doc ?? {}, 'unclassified')).toBe(true);
      expect(doc?.['unclassified']).toBeNull();
    });

    it('MUST keep pendingPrice PRESENT with value null after stamping', async () => {
      const harness = makeHarness();

      await harness.repository.insertIfAbsent(
        makeContractTrace({
          traceId: 'trace-pending',
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
          pendingPrice: { missingTokenTypes: ['input'] },
        }),
      );
      await harness.repository.stampPendingTrace('trace-pending', {
        stampedCosts: makeContractStampedCosts(),
        totalCostMicrocents: 330_000,
        stampedAt: new Date('2026-07-02T00:00:00.000Z'),
      });

      const doc = await MongoDb.getCollection(TRACES_COLLECTION).findOne({
        traceId: 'trace-pending',
      });

      expect(Object.hasOwn(doc ?? {}, 'pendingPrice')).toBe(true);
      expect(doc?.['pendingPrice']).toBeNull();
    });
  });
});
