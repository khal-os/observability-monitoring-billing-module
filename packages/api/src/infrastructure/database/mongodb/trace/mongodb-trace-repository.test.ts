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
import { traceIndexes } from '../migrations/003-trace-indexes.js';

/**
 * The Mongo adapter proves the SHARED TraceRepository contract — the
 * invariant tests themselves live with the port
 * (data/interfaces/trace-repository.contract.ts), written once for every
 * backend. Only the harness below is Mongo-aware.
 */
describe('MongoDbTraceRepository', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
    // insertIfAbsent's idempotency is ANCHORED on the unique traceId index
    // (audit C-7.3 removed the pre-insert findOne) — the test must run
    // against the same schema migration 003 bootstraps in production.
    await traceIndexes.run(MongoDb.getClient().db());
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
      await harness.repository.stampPendingTrace(
        'trace-pending',
        {
          stampedCosts: makeContractStampedCosts(),
          totalCostMicrocents: 330_000,
          stampedAt: new Date('2026-07-02T00:00:00.000Z'),
        },
        { id: 'gpt-5-mini', provider: 'openai' },
      );

      const doc = await MongoDb.getCollection(TRACES_COLLECTION).findOne({
        traceId: 'trace-pending',
      });

      expect(Object.hasOwn(doc ?? {}, 'pendingPrice')).toBe(true);
      expect(doc?.['pendingPrice']).toBeNull();
    });
  });

  // audit C-7.3: the skipped branch answers from the E11000 catch with the
  // stored token total — this is what ACTIVATES tokenDivergence detection
  // in the ingest path (Wave A wired the consumer; this is the producer).
  describe('insertIfAbsent skipped form (audit C-7.3 / B-4 residual)', () => {
    beforeEach(async () => {
      await makeHarness().reset();
    });

    it('MUST return the object form with the STORED tokensTotal on a duplicate', async () => {
      const harness = makeHarness();

      await harness.repository.insertIfAbsent(makeContractTrace());

      const result = await harness.repository.insertIfAbsent(
        makeContractTrace({
          tokens: { input: 9999 },
          tokensTotal: 9999, // the source kept growing after our ingest
        }),
      );

      expect(result).toEqual({ outcome: 'skipped', storedTokensTotal: 1200 });
    });
  });

  describe('reconcileQuarantineAfterClose (audit B-1, decision 100)', () => {
    const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
    const JULY_START = new Date('2026-07-01T00:00:00.000Z');

    const readQuarantine = async (traceId: string) =>
      (
        await MongoDb.getCollection(TRACES_COLLECTION).findOne({ traceId })
      )?.['billingQuarantine'] ?? null;

    beforeEach(async () => {
      await makeHarness().reset();
    });

    it('flags stragglers, absorbs the billed, leaves other months alone — idempotently', async () => {
      const harness = makeHarness();

      // In the snapshot, never flagged: stays untouched.
      await harness.repository.insertIfAbsent(
        makeContractTrace({ traceId: 'billed-clean' }),
      );
      // NOT in the snapshot, not flagged: the straggler the close race let
      // through — must end up flagged.
      await harness.repository.insertIfAbsent(
        makeContractTrace({ traceId: 'straggler' }),
      );
      // Flagged at ingest AND billed by this snapshot (reopen→re-close):
      // must be absorbed, original mark preserved.
      const quarantinedAt = new Date('2026-07-02T10:00:00.000Z');
      await harness.repository.insertIfAbsent(
        makeContractTrace({
          traceId: 'late-billed',
          billingQuarantine: { reason: 'period_closed', quarantinedAt },
        }),
      );
      // A JULY trace: outside the window, never touched.
      await harness.repository.insertIfAbsent(
        makeContractTrace({
          traceId: 'july-trace',
          startedAt: new Date('2026-07-05T00:00:00.000Z'),
        }),
      );

      const first = await harness.repository.reconcileQuarantineAfterClose(
        JUNE_START,
        JULY_START,
        ['billed-clean', 'late-billed'],
        2,
      );

      expect(first).toEqual({ flaggedStragglers: 1, absorbed: 1 });

      expect(await readQuarantine('billed-clean')).toBeNull();
      expect(await readQuarantine('straggler')).toMatchObject({
        reason: 'period_closed',
      });
      expect(await readQuarantine('late-billed')).toEqual({
        reason: 'period_closed',
        quarantinedAt, // the historical mark survives absorption
        absorbedInSnapshotVersion: 2,
      });
      expect(await readQuarantine('july-trace')).toBeNull();

      // Idempotent (crash-retry): the second run converges on the same
      // state and reports nothing new.
      const second = await harness.repository.reconcileQuarantineAfterClose(
        JUNE_START,
        JULY_START,
        ['billed-clean', 'late-billed'],
        2,
      );

      expect(second).toEqual({ flaggedStragglers: 0, absorbed: 0 });
      expect(await readQuarantine('late-billed')).toMatchObject({
        absorbedInSnapshotVersion: 2,
      });
    });

    it('a pending straggler is flagged too — it slipped past the close, only the reopen flow recovers it', async () => {
      const harness = makeHarness();

      await harness.repository.insertIfAbsent(
        makeContractTrace({
          traceId: 'pending-straggler',
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
        }),
      );

      await harness.repository.reconcileQuarantineAfterClose(
        JUNE_START,
        JULY_START,
        [],
        1,
      );

      expect(await readQuarantine('pending-straggler')).toMatchObject({
        reason: 'period_closed',
      });
    });
  });
});
