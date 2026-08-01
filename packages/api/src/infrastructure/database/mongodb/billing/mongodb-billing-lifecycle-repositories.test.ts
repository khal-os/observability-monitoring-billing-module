import { ClientSession } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import {
  BILLING_PERIODS_COLLECTION,
  MongoDbBillingPeriodRepository,
} from './mongodb-billing-period-repository.js';
import {
  BILLING_SNAPSHOTS_COLLECTION,
  BILLING_SNAPSHOT_USAGE_COLLECTION,
  MongoDbBillingSnapshotRepository,
} from './mongodb-billing-snapshot-repository.js';
import { MongoDbBillingQueryRepository } from './mongodb-billing-query-repository.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';
import { TRACES_COLLECTION } from '../collections.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../../domain/models/billing-snapshot-model.js';
import {
  BillingPeriodAuditEntry,
  closedMonthWindows,
  firstOpenMonthStart,
} from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodStateError } from '../../../../domain/useCases/close-billing-period-use-case.js';
import {
  buildStatement,
  collectAppliedPriceVersions,
} from '../../../../application/useCases/billingStatement/statement-engine.js';
import { CloseBillingPeriodDbUseCase } from '../../../../application/useCases/billingLifecycle/close-billing-period-db-use-case.js';
import { usageRecord } from '../../../../application/useCases/billingStatement/billing-test-fakes.js';
import { billingPeriodIndexes } from '../migrations/017-billing-period-indexes.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-b-001',
  agent: { id: 'eugenia', version: '1.0.0' },
  model: { id: 'claude-sonnet-4-6', provider: 'anthropic' },
  type: 'chat',
  channel: { type: 'whatsapp' },
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 1_000_000 },
  tokensTotal: 1_000_000,
  pricingStatus: 'stamped',
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 1_000_000,
      appliedPriceMicrocentsPerMillion: 2_500_000_000,
      appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      costMicrocents: 2_500_000_000,
    },
  ],
  totalCostMicrocents: 2_500_000_000,
  stampedAt: new Date('2026-06-05T14:01:00.000Z'),
  ingestedAt: new Date('2026-06-05T14:01:00.000Z'),
  input: 'in',
  output: 'out',
  spans: [],
  ...overrides,
});

const MAY_START = new Date('2026-05-01T00:00:00.000Z');
const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
const JULY_START = new Date('2026-07-01T00:00:00.000Z');

/**
 * The daily rollup's quarantine-exclusion scope (decisions 97/100): June
 * CLOSED — its days must sum to its frozen bill, so an unresolved
 * straggler inside the window stays out. The same shape the series use
 * case derives with `closedMonthWindows(periods)`.
 */
const JUNE_CLOSED_WINDOWS = [{ start: JUNE_START, end: JULY_START }];

const makeSnapshot = (
  version: number,
  records: ReturnType<typeof usageRecord>[],
): BillingSnapshotModel => ({
  year: 2026,
  month: 6,
  version,
  createdAt: new Date('2026-07-01T03:00:00.000Z'),
  trigger: 'runbook',
  ingestionWatermark: new Date('2026-06-30T23:59:59.000Z'),
  logicVersion: 'statement-engine/1',
  roundingRule: 'half-up 2 casas',
  statement: buildStatement(records),
  exceptions: [],
  priceVersionsApplied: [],
  usageRecordCount: records.length,
});

describe('Billing lifecycle repositories (integration)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
    // The conflict guards lean on the unique indexes migration 017
    // bootstraps — the test runs against the same schema production gets.
    await billingPeriodIndexes.run(MongoDb.getClient().db());
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    for (const collection of [
      BILLING_PERIODS_COLLECTION,
      BILLING_SNAPSHOTS_COLLECTION,
      BILLING_SNAPSHOT_USAGE_COLLECTION,
      TRACES_COLLECTION,
      'trace_filter_counters',
      'session_summaries',
    ]) {
      await MongoDb.getCollection(collection).deleteMany({});
    }
  });

  describe('MongoDbBillingPeriodRepository', () => {
    it('close → find → reopen → audit trail preserved', async () => {
      const sut = new MongoDbBillingPeriodRepository();
      const closedAt = new Date('2026-07-01T03:00:00.000Z');

      expect(await sut.find(2026, 6)).toBeNull();

      const outcome = await sut.markClosed({
        year: 2026,
        month: 6,
        closedAt,
        snapshotVersion: 1,
        audit: {
          at: closedAt,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });
      expect(outcome).toBe('closed');

      const period = await sut.find(2026, 6);
      expect(period?.status).toBe('closed');
      expect(period?.snapshotVersion).toBe(1);

      // A second close of a closed month must lose (T6: immutable until reopen).
      expect(
        await sut.markClosed({
          year: 2026,
          month: 6,
          closedAt,
          snapshotVersion: 2,
          audit: {
            at: closedAt,
            action: 'close',
            trigger: 'runbook',
            snapshotVersion: 2,
          },
        }),
      ).toBe('conflict');

      expect(
        await sut.markReopened({
          year: 2026,
          month: 6,
          audit: {
            at: new Date(),
            action: 'reopen',
            trigger: 'runbook',
            reason: 'correção',
            snapshotVersion: 1,
          },
        }),
      ).toBe('reopened');

      const reopened = await sut.find(2026, 6);
      expect(reopened?.status).toBe('open');
      // snapshotVersion survives the reopen — the next close writes v+1.
      expect(reopened?.snapshotVersion).toBe(1);
      expect(reopened?.audit.map((entry) => entry.action)).toEqual([
        'close',
        'reopen',
      ]);

      // Reopening an open month must lose.
      expect(
        await sut.markReopened({
          year: 2026,
          month: 6,
          audit: {
            at: new Date(),
            action: 'reopen',
            trigger: 'runbook',
            reason: 'de novo',
            snapshotVersion: 1,
          },
        }),
      ).toBe('conflict');
    });
  });

  describe('MongoDbBillingSnapshotRepository', () => {
    it('stores header + usage records, reads current/version/inputs back intact', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const records = [
        usageRecord({ traceId: 'x1' }),
        usageRecord({ traceId: 'x2', agentId: 'suporte' }),
      ];

      await sut.insert(makeSnapshot(1, records), records);
      await sut.insert(makeSnapshot(2, [records[0]!]), [records[0]!]);

      expect((await sut.findCurrent(2026, 6))?.version).toBe(2);
      expect((await sut.findVersion(2026, 6, 1))?.version).toBe(1);

      const storedInputs = await sut.findUsageRecords(2026, 6, 1);
      expect(storedInputs.map((record) => record.traceId)).toEqual(['x1', 'x2']);
      expect(storedInputs[0]?.stampedCosts[0]?.costMicrocents).toBe(
        2_500_000_000,
      );
      expect(storedInputs[0]?.startedAt).toBeInstanceOf(Date);

      // The engine over stored inputs must equal the stored output —
      // the same reproducibility contract, through the REAL storage.
      const reproduced = buildStatement(storedInputs);
      const stored = await sut.findVersion(2026, 6, 1);
      expect(JSON.parse(JSON.stringify(reproduced))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });

    it('listVersions: every version of the month, ascending, from one read (audit C-7.3)', async () => {
      const sut = new MongoDbBillingSnapshotRepository();

      await sut.insert(makeSnapshot(2, []), []);
      await sut.insert(makeSnapshot(1, []), []);
      // Another month must not leak in.
      await sut.insert({ ...makeSnapshot(1, []), month: 5 }, []);

      const versions = await sut.listVersions(2026, 6);

      expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
      expect(versions[0]?.createdAt).toBeInstanceOf(Date);
      expect(await sut.listVersions(2026, 4)).toEqual([]);
    });
  });

  describe('insertWithPeriodClose — the atomic close write (audit B-2, M8)', () => {
    const CLOSED_AT = new Date('2026-07-01T03:00:00.000Z');

    const closeArgs = (version: number) => ({
      closedAt: CLOSED_AT,
      audit: {
        at: CLOSED_AT,
        action: 'close',
        trigger: 'runbook',
        snapshotVersion: version,
      } as BillingPeriodAuditEntry,
    });

    it('lands inputs + header + period flip together, and the period reads closed', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const records = [usageRecord({ traceId: 'a1' })];

      const outcome = await sut.insertWithPeriodClose(
        makeSnapshot(1, records),
        records,
        closeArgs(1),
      );

      expect(outcome).toBe('closed');

      const period = await periods.find(2026, 6);
      expect(period?.status).toBe('closed');
      expect(period?.snapshotVersion).toBe(1);
      expect(period?.audit.map((entry) => entry.action)).toEqual(['close']);
      expect((await sut.findCurrent(2026, 6))?.version).toBe(1);
      expect(
        (await sut.findUsageRecords(2026, 6, 1)).map((r) => r.traceId),
      ).toEqual(['a1']);
    });

    it('stages the usage rows in BOUNDED chunks, under an ATTEMPT-scoped key, and publishes every one', async () => {
      // The month's usage set is one record per stamped trace and
      // unbounded — it used to ride the close transaction in a single
      // insertMany and abort with TransactionTooLargeForCache. It is now
      // staged outside the transaction, chunk by chunk, under a key
      // private to this attempt (two concurrent closes compute the SAME
      // version, so the key cannot be version-scoped alone).
      class ChunkCountingRepository extends MongoDbBillingSnapshotRepository {
        readonly chunkSizes: number[] = [];

        protected override async insertUsageChunk(
          stagingKey: string,
          chunk: BillingUsageRecord[],
        ): Promise<void> {
          this.chunkSizes.push(chunk.length);

          return super.insertUsageChunk(stagingKey, chunk);
        }
      }

      const sut = new ChunkCountingRepository(2);
      const records = ['r1', 'r2', 'r3', 'r4', 'r5'].map((traceId) =>
        usageRecord({ traceId }),
      );

      expect(
        await sut.insertWithPeriodClose(
          makeSnapshot(1, records),
          records,
          closeArgs(1),
        ),
      ).toBe('closed');

      expect(sut.chunkSizes).toEqual([2, 2, 1]);

      const rawRows = await MongoDb.getCollection(
        BILLING_SNAPSHOT_USAGE_COLLECTION,
      )
        .find({})
        .toArray();

      expect(rawRows).toHaveLength(5);
      expect([...new Set(rawRows.map((row) => row['snapshotKey']))]).toEqual([
        expect.stringMatching(/^2026-06-v1#.+/),
      ]);

      const storedInputs = await sut.findUsageRecords(2026, 6, 1);
      const stored = await sut.findCurrent(2026, 6);

      expect(storedInputs.map((record) => record.traceId)).toEqual([
        'r1',
        'r2',
        'r3',
        'r4',
        'r5',
      ]);
      expect(storedInputs).toHaveLength(stored?.usageRecordCount as number);
      expect(await sut.findUsageTraceIds(2026, 6, 1)).toHaveLength(5);
      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });

    it('TransactionTooLargeForCache (388) surfaces as a TYPED state error naming MONGO_MEMORY_LIMIT', async () => {
      // The two-phase write keeps the commit transaction at two documents,
      // but 388 carries no TransientTransactionError label and is
      // deterministic — if it ever fires, the runbook must print an
      // actionable message, never a raw driver stack.
      class CacheBoundSnapshotRepository extends MongoDbBillingSnapshotRepository {
        protected override async flipPeriodClosed(): Promise<
          'closed' | 'conflict'
        > {
          throw Object.assign(
            new Error(
              'transaction is too large and will not fit in the storage engine cache',
            ),
            { code: 388 },
          );
        }
      }

      const sut = new CacheBoundSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const records = [usageRecord({ traceId: 'big-1' })];

      const error = await sut
        .insertWithPeriodClose(makeSnapshot(1, records), records, closeArgs(1))
        .then(() => null)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(BillingPeriodStateError);
      expect((error as Error).message).toContain('MONGO_MEMORY_LIMIT');
      // Nothing published: no header, no flip.
      expect(await periods.find(2026, 6)).toBeNull();
      expect(await sut.findCurrent(2026, 6)).toBeNull();
    });

    it('CRASH between the snapshot writes and the flip aborts EVERYTHING — the retry closes cleanly and reproduces', async () => {
      class CrashingSnapshotRepository extends MongoDbBillingSnapshotRepository {
        crashes = 1;

        protected override async flipPeriodClosed(
          session: ClientSession,
          args: {
            year: number;
            month: number;
            closedAt: Date;
            snapshotVersion: number;
            audit: BillingPeriodAuditEntry;
          },
        ): Promise<'closed' | 'conflict'> {
          if (this.crashes > 0) {
            this.crashes -= 1;
            throw new Error('simulated crash before the flip');
          }

          return super.flipPeriodClosed(session, args);
        }
      }

      const sut = new CrashingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const records = [usageRecord({ traceId: 'c1' })];

      await expect(
        sut.insertWithPeriodClose(makeSnapshot(1, records), records, closeArgs(1)),
      ).rejects.toThrow('simulated crash before the flip');

      // The commit transaction rolled back: no orphan header, period
      // untouched — the exact opposite of the pre-fix wedge.
      expect(
        await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION).countDocuments({}),
      ).toBe(0);
      expect(await periods.find(2026, 6)).toBeNull();

      // The STAGED usage row is written outside the bounded commit
      // transaction on purpose (re-audit: the month's usage set is
      // unbounded and used to blow the WiredTiger transaction cache), so
      // the abort cannot roll it back. It is dropped explicitly instead:
      // this attempt did not publish, so its area is dead the moment the
      // write returns (re-audit iteration 3 — it used to survive forever,
      // unreachable but on disk).
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOT_USAGE_COLLECTION,
        ).countDocuments({}),
      ).toBe(0);
      expect(await sut.findUsageRecords(2026, 6, 1)).toEqual([]);
      expect(await sut.findUsageTraceIds(2026, 6, 1)).toEqual([]);

      // The retry (same version — nothing advanced) succeeds and the
      // stored inputs reproduce the stored statement.
      const retried = await sut.insertWithPeriodClose(
        makeSnapshot(1, records),
        records,
        closeArgs(1),
      );

      expect(retried).toBe('closed');

      const storedInputs = await sut.findUsageRecords(2026, 6, 1);
      const stored = await sut.findCurrent(2026, 6);

      expect(storedInputs.map((record) => record.traceId)).toEqual(['c1']);
      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
      // Exactly the published rows remain.
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOT_USAGE_COLLECTION,
        ).countDocuments({}),
      ).toBe(1);
    });

    it('an already-closed period answers conflict and leaves NOTHING on disk — not even staged rows', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const records = [usageRecord({ traceId: 'w1' })];

      await sut.insertWithPeriodClose(makeSnapshot(1, records), records, closeArgs(1));

      const late = [
        usageRecord({ traceId: 'l1' }),
        usageRecord({ traceId: 'l2' }),
        usageRecord({ traceId: 'l3' }),
      ];
      const outcome = await sut.insertWithPeriodClose(
        makeSnapshot(2, late),
        late,
        closeArgs(2),
      );

      expect(outcome).toBe('conflict');
      expect(await sut.findCurrent(2026, 6)).toMatchObject({ version: 1 });
      expect(await sut.findUsageRecords(2026, 6, 2)).toEqual([]);
      // "writes NOTHING" was asserted THROUGH the header indirection only,
      // which is blind to the rows on disk: the loser had already staged
      // its whole month under a key no header names, and the
      // version-keyed sweep can never reach it (the next close computes
      // v+1). Assert the disk (re-audit iteration 3).
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOT_USAGE_COLLECTION,
        ).countDocuments({}),
      ).toBe(1);
    });

    it('a duplicate (year, month, version) header surfaces as a TYPED state error', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const records = [usageRecord({ traceId: 'd1' })];

      // An orphan v1 header exists while the period is still open — the
      // (rare) legacy crash shape. The typed error replaces a raw E11000.
      await sut.insert(makeSnapshot(1, records), records);

      await expect(
        sut.insertWithPeriodClose(makeSnapshot(1, records), records, closeArgs(1)),
      ).rejects.toThrow(BillingPeriodStateError);
      expect(await periods.find(2026, 6)).toBeNull();
      // The refused attempt staged its rows before the header collided —
      // and dropped them on the way out: only the orphan header's row
      // remains (re-audit iteration 3).
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOT_USAGE_COLLECTION,
        ).countDocuments({}),
      ).toBe(1);
    });

    it('CONCURRENT double close: exactly one wins; the usage rows belong to the winning header (M8)', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const recordsA = [
        usageRecord({ traceId: 'a-1' }),
        usageRecord({ traceId: 'a-2' }),
      ];
      const recordsB = [usageRecord({ traceId: 'b-1' })];

      const [resultA, resultB] = await Promise.allSettled([
        sut.insertWithPeriodClose(makeSnapshot(1, recordsA), recordsA, closeArgs(1)),
        sut.insertWithPeriodClose(makeSnapshot(1, recordsB), recordsB, closeArgs(1)),
      ]);

      const closedFlags = [resultA, resultB].map(
        (result) => result.status === 'fulfilled' && result.value === 'closed',
      );

      // Exactly one winner; the loser answers 'conflict' or the typed
      // duplicate-header error — never a raw driver error.
      expect(closedFlags.filter(Boolean)).toHaveLength(1);
      for (const result of [resultA, resultB]) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(BillingPeriodStateError);
        }
      }

      const winnerRecords = closedFlags[0] ? recordsA : recordsB;
      const storedInputs = await sut.findUsageRecords(2026, 6, 1);

      // The invariant B-2 exists for: the stored inputs are EXACTLY the
      // winner's — no cross-contamination from the loser's writes, which
      // sit in their own staging area (both attempts compute the SAME
      // version, so a merely version-scoped key would mix them) — and
      // they reproduce the winning statement.
      expect(storedInputs.map((record) => record.traceId).sort()).toEqual(
        winnerRecords.map((record: BillingUsageRecord) => record.traceId).sort(),
      );
      expect(
        await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION).countDocuments(
          { year: 2026, month: 6 },
        ),
      ).toBe(1);
      expect((await periods.find(2026, 6))?.snapshotVersion).toBe(1);

      const stored = await sut.findCurrent(2026, 6);
      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });
  });

  describe('MongoDbBillingQueryRepository (new reads)', () => {
    it('fetchUsageRecords: stamped traces only, stamps verbatim, traceId order', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(makeTrace({ traceId: 'b' }));
      await traces.insertIfAbsent(makeTrace({ traceId: 'a' }));
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'pending-1',
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
          pendingPrice: null as never,
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const records = await sut.fetchUsageRecords(JUNE_START, JULY_START);

      expect(records.map((record) => record.traceId)).toEqual(['a', 'b']);
      expect(records[0]?.model).toBe('anthropic/claude-sonnet-4-6');
      expect(records[0]?.stampedCosts[0]?.appliedPriceEffectiveFrom).toBeInstanceOf(
        Date,
      );
    });

    it('watermark, quarantine count and accrued window', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'q1',
          ingestedAt: new Date('2026-06-20T10:00:00.000Z'),
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'q2',
          startedAt: new Date('2026-06-10T00:00:00.000Z'),
          ingestedAt: new Date('2026-06-25T10:00:00.000Z'),
        }),
      );

      const sut = new MongoDbBillingQueryRepository();

      expect(await sut.ingestionWatermark(JUNE_START, JULY_START)).toEqual(
        new Date('2026-06-25T10:00:00.000Z'),
      );
      expect(await sut.countQuarantined(JUNE_START, JULY_START)).toBe(1);
      // accrued: only traces before the cut.
      expect(
        await sut.accruedCostMicrocents(
          JUNE_START,
          new Date('2026-06-05T00:00:00.000Z'),
        ),
      ).toBe(0);
      expect(
        await sut.accruedCostMicrocents(JUNE_START, JULY_START),
      ).toBe(5_000_000_000);
    });

    it('monthlyRollup groups by month with per-agent and per-model sums', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(makeTrace({ traceId: 'jun-1' }));
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jul-1',
          agent: { id: 'suporte' },
          startedAt: new Date('2026-07-02T00:00:00.000Z'),
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const rollup = await sut.monthlyRollup();

      const inputSplit = [
        { tokenType: 'input', costMicrocents: 2_500_000_000 },
      ];
      expect(rollup.map((row) => row.month)).toEqual([6, 7]);
      expect(rollup[0]?.byTokenType).toEqual(inputSplit);
      expect(rollup[0]?.byAgent).toEqual([
        {
          agentId: 'eugenia',
          costMicrocents: 2_500_000_000,
          byTokenType: inputSplit,
        },
      ]);
      expect(rollup[1]?.byAgent).toEqual([
        {
          agentId: 'suporte',
          costMicrocents: 2_500_000_000,
          byTokenType: inputSplit,
        },
      ]);
      expect(rollup[0]?.byModel).toEqual([
        {
          model: 'anthropic/claude-sonnet-4-6',
          costMicrocents: 2_500_000_000,
          byTokenType: inputSplit,
        },
      ]);
    });

    it('countQuarantined: only UNRESOLVED quarantine counts — an absorbed trace is billed (decision 100)', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'unresolved',
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'absorbed',
          startedAt: new Date('2026-06-10T00:00:00.000Z'),
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
            absorbedInSnapshotVersion: 2,
          },
        }),
      );

      const sut = new MongoDbBillingQueryRepository();

      expect(await sut.countQuarantined(JUNE_START, JULY_START)).toBe(1);
    });

    it('pendingPriceSummary counts pending APART — unresolved-quarantined pending is outside the CLOSED-month lens ONLY (M6, decision 100, scoped by the re-audit)', async () => {
      const traces = new MongoDbTraceRepository();
      const pending = (overrides: Partial<TraceModel>) =>
        makeTrace({
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
          model: { id: 'llama-4-scout', provider: 'meta' },
          tokens: { input: 500, output: 100 },
          ...overrides,
        });

      await traces.insertIfAbsent(makeTrace({ traceId: 'stamped-1' }));
      await traces.insertIfAbsent(pending({ traceId: 'pending-normal' }));
      // Post-close straggler, still pending. Inside a FROZEN month it is
      // outside the bill by construction (countQuarantined carries it) —
      // but the moment the month is REOPENED the live statement bills that
      // month, so it becomes an open cost that must block the re-close
      // (re-audit iteration 2). One trace, two lenses, both asserted.
      await traces.insertIfAbsent(
        pending({
          traceId: 'pending-quarantined',
          model: { id: 'nova-2', provider: 'amazon' },
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const frozen = await sut.pendingPriceSummary(JUNE_START, JULY_START, {
        excludeUnresolvedQuarantine: true,
      });

      expect(frozen.traceCount).toBe(1);
      expect(frozen.tokens).toEqual({
        input: 500,
        output: 100,
        cache_read: 0,
        cache_write: 0,
      });
      // Under the frozen lens only the in-scope pending trace's model shows.
      expect(frozen.models).toEqual(['meta/llama-4-scout']);

      // The live lens — what a REOPENED month reads, what the close guard
      // asks, and what blocks the re-close until the straggler is priced.
      const live = await sut.pendingPriceSummary(JUNE_START, JULY_START, {
        excludeUnresolvedQuarantine: false,
      });

      expect(live.traceCount).toBe(2);
      expect(live.tokens).toEqual({
        input: 1_000,
        output: 200,
        cache_read: 0,
        cache_write: 0,
      });
      expect(live.models).toEqual(['amazon/nova-2', 'meta/llama-4-scout']);
    });

    it('listBills (M6): per-month counts, the B-10.4 token pair, and decision-100 pending semantics', async () => {
      const traces = new MongoDbTraceRepository();

      await traces.insertIfAbsent(makeTrace({ traceId: 'jun-stamped' }));
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jun-pending',
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
          tokens: { input: 300 },
          tokensTotal: 300,
        }),
      );
      // Unresolved-quarantined pending: outside the bill ONLY while June
      // is frozen. Reopen June (drop it from the closed windows) and it is
      // an open cost of the live bill again — asserted both ways below.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jun-pending-quarantined',
          pricingStatus: 'pending_price',
          stampedCosts: undefined,
          totalCostMicrocents: undefined,
          stampedAt: undefined,
          tokens: { input: 7 },
          tokensTotal: 7,
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jul-stamped',
          startedAt: new Date('2026-07-02T00:00:00.000Z'),
          tokens: { input: 2_000, output: 500 },
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const juneWindow = { start: JUNE_START, end: JULY_START };
      const rows = await sut.listBills(null, [juneWindow]);

      expect(rows.map((row) => [row.year, row.month])).toEqual([
        [2026, 7],
        [2026, 6],
      ]);
      expect(rows[1]).toEqual({
        year: 2026,
        month: 6,
        totalCostMicrocents: 2_500_000_000,
        stampedTraceCount: 1,
        pendingTraceCount: 1, // June is CLOSED: the quarantined one is out
        tokens: 1_000_000 + 300, // stamped + in-scope pending volume
        stampedTokens: 1_000_000, // billed volume only (B-10.4)
      });
      expect(rows[0]).toMatchObject({ tokens: 2_500, stampedTokens: 2_500 });

      // Re-audit iteration 2 — REOPEN June (no closed window covers it):
      // the straggler is an open cost of the live bill again, so /bills
      // must report exactly what pendingPriceSummary reports to
      // /billing/summary and to the close guard. Anything else is one
      // month with two pending numbers.
      const reopened = await sut.listBills(null, []);
      const livePending = await sut.pendingPriceSummary(
        JUNE_START,
        JULY_START,
        { excludeUnresolvedQuarantine: false },
      );

      expect(reopened[1]).toMatchObject({
        month: 6,
        pendingTraceCount: 2,
        tokens: 1_000_000 + 300 + 7,
      });
      expect(reopened[1]?.pendingTraceCount).toBe(livePending.traceCount);

      // audit C-7.1: the bound cuts closed history out of the scan.
      const bounded = await sut.listBills(JULY_START, [juneWindow]);

      expect(bounded.map((row) => row.month)).toEqual([7]);
    });

    /**
     * Re-audit iteration 3, end to end over the REAL store: close June,
     * then let a May trace arrive. May was never touched by a lifecycle
     * action, so it owns NO period document — the bound has to come from
     * the DATA (`earliestTraceAt`) or the month's money is invisible to
     * /bills and to the monthly series while /billing/summary bills it.
     */
    it('C-7.1 bound: a trace arriving for a NEVER-closed month older than the closed one stays in /bills AND in the series', async () => {
      const traces = new MongoDbTraceRepository();
      const periodRepository = new MongoDbBillingPeriodRepository();
      const sut = new MongoDbBillingQueryRepository();

      await traces.insertIfAbsent(makeTrace({ traceId: 'jun-stamped' }));
      await periodRepository.markClosed({
        year: 2026,
        month: 6,
        closedAt: JULY_START,
        snapshotVersion: 1,
        audit: {
          at: JULY_START,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });

      // Day-2 backfill over the never-closed month (README's dead-letter
      // recovery): stamped, unquarantined, fully billable.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'may-late-1',
          startedAt: new Date('2026-05-20T12:00:00.000Z'),
          tokens: { input: 4_000_000 },
          tokensTotal: 4_000_000,
          stampedCosts: [
            {
              tokenType: 'input',
              tokens: 4_000_000,
              appliedPriceMicrocentsPerMillion: 2_500_000_000,
              appliedPriceEffectiveFrom: MAY_START,
              costMicrocents: 10_000_000_000,
            },
          ],
          totalCostMicrocents: 10_000_000_000,
        }),
      );

      const periods = await periodRepository.listAll();
      const bound = firstOpenMonthStart(periods, await sut.earliestTraceAt());

      expect(bound).toEqual(MAY_START);

      const bills = await sut.listBills(bound, closedMonthWindows(periods));
      const rollup = await sut.monthlyRollup(bound);

      expect(bills.map((row) => row.month)).toEqual([6, 5]);
      expect(bills[1]).toMatchObject({
        year: 2026,
        month: 5,
        totalCostMicrocents: 10_000_000_000,
        stampedTraceCount: 1,
        stampedTokens: 4_000_000,
      });
      expect(rollup.map((row) => [row.month, row.totalCostMicrocents])).toEqual([
        [5, 10_000_000_000],
        [6, 2_500_000_000],
      ]);

      // The third reader of the same store — /billing/summary's live path,
      // which never had a bound — must report the SAME money (invariant 3).
      const statement = buildStatement(
        await sut.fetchUsageRecords(MAY_START, JUNE_START),
      );

      expect(statement.totalCostMicrocents).toBe(bills[1]?.totalCostMicrocents);

      // What the period documents alone can say: nothing. Without the data
      // anchor the walk starts at the earliest CLOSED month, and the bound
      // it lands on cuts May out of both live readers while the statement
      // above still bills it. (June's absence there is correct — a closed
      // month is served from its snapshot; May's is the defect.)
      expect(firstOpenMonthStart(periods, null)).toEqual(JULY_START);
      expect(
        (await sut.listBills(JULY_START, closedMonthWindows(periods))).map(
          (row) => row.month,
        ),
      ).toEqual([]);
      expect(await sut.monthlyRollup(JULY_START)).toEqual([]);
    });

    it('dailyRollup buckets by UTC day, splits by type, EXCLUDES quarantined (decision 97)', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'd1',
          startedAt: new Date('2026-06-05T23:50:00.000Z'),
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'd2',
          startedAt: new Date('2026-06-05T02:00:00.000Z'),
          stampedCosts: [
            {
              tokenType: 'output',
              tokens: 100,
              appliedPriceMicrocentsPerMillion: 1_000_000,
              appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
              costMicrocents: 100,
            },
          ],
          totalCostMicrocents: 100,
        }),
      );
      // Quarantined: outside every bill — must not chart either.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'd3',
          startedAt: new Date('2026-06-05T10:00:00.000Z'),
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'd4',
          startedAt: new Date('2026-06-06T01:00:00.000Z'),
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const days = await sut.dailyRollup(
        JUNE_START,
        JULY_START,
        JUNE_CLOSED_WINDOWS,
      );

      expect(days.map((day) => [day.date.getUTCDate(), day.totalCostMicrocents])).toEqual([
        [5, 2_500_000_100],
        [6, 2_500_000_000],
      ]);
      expect(days[0]?.byTokenType).toEqual(
        expect.arrayContaining([
          { tokenType: 'input', costMicrocents: 2_500_000_000 },
          { tokenType: 'output', costMicrocents: 100 },
        ]),
      );
    });

    it('dailyRollup INCLUDES absorbed quarantined traces — billed by v+1, so they chart (decision 100)', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(makeTrace({ traceId: 'norm-1' }));
      // Absorbed by a re-close: in the bill → in the days (decision 89).
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'absorbed-1',
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
            absorbedInSnapshotVersion: 2,
          },
        }),
      );
      // Unresolved: outside the bill → outside the days.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'unresolved-1',
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );

      const sut = new MongoDbBillingQueryRepository();
      const days = await sut.dailyRollup(
        JUNE_START,
        JULY_START,
        JUNE_CLOSED_WINDOWS,
      );

      expect(days).toHaveLength(1);
      expect(days[0]?.totalCostMicrocents).toBe(5_000_000_000);
    });

    it('dailyRollup excludes unresolved quarantine ONLY inside CLOSED months — a reopened month charts its straggler', async () => {
      const traces = new MongoDbTraceRepository();
      await traces.insertIfAbsent(makeTrace({ traceId: 'norm-1' }));
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'straggler-1',
          billingQuarantine: {
            reason: 'period_closed',
            quarantinedAt: new Date(),
          },
        }),
      );

      const sut = new MongoDbBillingQueryRepository();

      // June REOPENED (or never closed): no window in scope. The live
      // summary bills every stamped trace — straggler included — so the
      // days must chart it too, or Σ daily ≠ summary for the whole
      // reopen→re-close window (re-audit divergence).
      const openDays = await sut.dailyRollup(JUNE_START, JULY_START, []);

      expect(openDays[0]?.totalCostMicrocents).toBe(5_000_000_000);

      // Same store, June CLOSED: the straggler is outside the frozen bill.
      const closedDays = await sut.dailyRollup(
        JUNE_START,
        JULY_START,
        JUNE_CLOSED_WINDOWS,
      );

      expect(closedDays[0]?.totalCostMicrocents).toBe(2_500_000_000);
    });
  });

  describe('re-audit iteration 3: a close that does not publish leaves NO staged rows', () => {
    const CLOSED_AT = new Date('2026-07-01T03:00:00.000Z');

    const closeArgs = (version: number) => ({
      closedAt: CLOSED_AT,
      audit: {
        at: CLOSED_AT,
        action: 'close',
        trigger: 'runbook',
        snapshotVersion: version,
      } as BillingPeriodAuditEntry,
    });

    const usageRows = (): Promise<number> =>
      MongoDb.getCollection(BILLING_SNAPSHOT_USAGE_COLLECTION).countDocuments(
        {},
      );

    it('the staged form publishes every page and NOTHING else — the close of an unbounded month', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();
      const pages = [
        [usageRecord({ traceId: 'd02-1' }), usageRecord({ traceId: 'd02-2' })],
        [usageRecord({ traceId: 'd17-1' })],
        [usageRecord({ traceId: 'd28-1' })],
      ];

      const outcome = await sut.insertWithPeriodCloseStaged(
        { year: 2026, month: 6, version: 1 },
        async (stage) => {
          for (const page of pages) {
            await stage(page);
          }

          return makeSnapshot(1, pages.flat());
        },
        closeArgs(1),
      );

      expect(outcome).toBe('closed');
      expect((await periods.find(2026, 6))?.status).toBe('closed');
      expect(
        (await sut.findUsageRecords(2026, 6, 1)).map((row) => row.traceId),
      ).toEqual(['d02-1', 'd02-2', 'd17-1', 'd28-1']);
      expect(await usageRows()).toBe(4);
    });

    it('a caller that throws MID-PAGING drops the pages it already staged', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();

      // The shape the paged close takes when a day's read fails: two
      // pages are already on disk under this attempt's key, and no header
      // will ever name them.
      await expect(
        sut.insertWithPeriodCloseStaged(
          { year: 2026, month: 6, version: 1 },
          async (stage) => {
            await stage([usageRecord({ traceId: 'p1' })]);
            await stage([usageRecord({ traceId: 'p2' })]);

            throw new Error('leitura do dia 17 falhou');
          },
          closeArgs(1),
        ),
      ).rejects.toThrow('leitura do dia 17 falhou');

      expect(await usageRows()).toBe(0);
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOTS_COLLECTION,
        ).countDocuments({}),
      ).toBe(0);
      expect(await periods.find(2026, 6)).toBeNull();
    });

    it('a header that does not match the staging identity is refused, and its rows go with it', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const records = [usageRecord({ traceId: 'mismatch-1' })];

      // A header published under v1 while the rows were staged for v2
      // would name an area that does not exist: the snapshot would read
      // back EMPTY and its own reproducibility test would fail. Refuse.
      await expect(
        sut.insertWithPeriodCloseStaged(
          { year: 2026, month: 6, version: 2 },
          async (stage) => {
            await stage(records);

            return makeSnapshot(1, records);
          },
          closeArgs(2),
        ),
      ).rejects.toThrow(/identidade/);

      expect(await usageRows()).toBe(0);
      expect(await sut.findCurrent(2026, 6)).toBeNull();
    });

    it('END TO END on the REAL query adapter: the day-paged close bills the month exactly once', async () => {
      const traces = new MongoDbTraceRepository();
      // Three days, inserted out of order, one of them at the very last
      // second of its UTC day: a window that is off by one anywhere drops
      // a trace or bills it twice.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jun-28',
          startedAt: new Date('2026-06-28T12:00:00.000Z'),
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jun-05',
          startedAt: new Date('2026-06-05T00:00:00.000Z'),
        }),
      );
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'jun-17',
          startedAt: new Date('2026-06-17T23:59:59.999Z'),
        }),
      );

      const queries = new MongoDbBillingQueryRepository();
      const snapshots = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();

      const result = await new CloseBillingPeriodDbUseCase({
        billingQueryRepository: queries,
        billingPeriodRepository: periods,
        billingSnapshotRepository: snapshots,
        traceRepository: traces,
        now: () => new Date('2026-07-15T10:00:00.000Z'),
      }).close(2026, 6);

      const wholeMonth = await queries.fetchUsageRecords(JUNE_START, JULY_START);
      const stored = await snapshots.findCurrent(2026, 6);

      expect(result.stampedTraceCount).toBe(3);
      expect(stored?.usageRecordCount).toBe(3);
      // Σ days ≡ the month, and the statement is the SAME bytes the
      // whole-month read produces (re-audit iteration 3).
      expect(JSON.parse(JSON.stringify(stored?.statement))).toEqual(
        JSON.parse(JSON.stringify(buildStatement(wholeMonth))),
      );
      expect(
        (await snapshots.findUsageRecords(2026, 6, 1)).map((row) => row.traceId),
      ).toEqual(['jun-05', 'jun-17', 'jun-28']);
      expect(await usageRows()).toBe(3);
    });

    /**
     * Re-audit iteration 4, end to end over the REAL adapters — the case
     * the one above structurally cannot make: its traceIds ('jun-05',
     * 'jun-17', 'jun-28') sort in the SAME order as their days, so the
     * day-paged fold and the traceId-ordered readers feed the engine the
     * identical sequence and no fold-order divergence is observable even
     * if one exists.
     *
     * Here the fixture carries a PRICE-ONLY TIE with the orders REVERSED:
     * two stamped traces equal in agent, agentVersion, model, tokenType
     * and appliedPriceEffectiveFrom — every dimension `lineKey` groups by
     * EXCEPT the applied unit price — where the one on the EARLIER day
     * sorts LATER by traceId. The shape is reachable in production via
     * migration 019 (decision 102): it lowercases `traces.model` while
     * leaving a colliding case-variant price row as stored, so two stamps
     * with different unit prices land under one canonical model key.
     *
     * The close folds day by day (decision 120: 02 → 17 → 28), while
     * `fetchUsageRecords` and `findUsageRecords` both answer in traceId
     * order (28 → 17 → 02). Until decision 122 `compareLines` omitted the
     * price term, so the two tie lines compared EQUAL and the stable sort
     * left them in Map-INSERTION order — the frozen snapshot could not be
     * reproduced from its own stored inputs, and `reconcileDisplayCents`
     * (which breaks its remainder tie BY INDEX) showed the same line at
     * different centavos live and frozen.
     *
     * Costs sit on a HALF centavo each (1_500_000 and 2_500_000 µ¢) and
     * the third trace is an exact 2500 centavos, so the reconciliation has
     * a deficit of exactly 1 whose only candidates are the tie pair — the
     * displayed-cents assertion is load-bearing, not vacuous.
     */
    it('END TO END on the REAL adapters: a PRICE-only tie whose traceId order REVERSES its day order still reproduces, centavos included', async () => {
      const traces = new MongoDbTraceRepository();
      const tieTrace = (traceId: string, day: string, price: number) =>
        makeTrace({
          traceId,
          startedAt: new Date(`2026-06-${day}T10:00:00.000Z`),
          finishedAt: new Date(`2026-06-${day}T10:00:04.000Z`),
          model: { id: 'claude-x', provider: 'anthropic' },
          stampedCosts: [
            {
              tokenType: 'input',
              tokens: 1_000_000,
              appliedPriceMicrocentsPerMillion: price,
              appliedPriceEffectiveFrom: JUNE_START,
              costMicrocents: price,
            },
          ],
          totalCostMicrocents: price,
        });

      // Day 02 but LAST by traceId; day 28 but FIRST by traceId.
      await traces.insertIfAbsent(tieTrace('z-tie-cheap', '02', 1_500_000));
      await traces.insertIfAbsent(tieTrace('a-tie-dear', '28', 2_500_000));
      // A whole-centavo line between them: it keeps the reconciliation's
      // deficit at 1 and gives the tie pair a neighbour that does NOT tie,
      // so the assertions below are about the tie and nothing else.
      await traces.insertIfAbsent(
        makeTrace({
          traceId: 'm-plain',
          startedAt: new Date('2026-06-17T09:00:00.000Z'),
          finishedAt: new Date('2026-06-17T09:00:04.000Z'),
        }),
      );

      const queries = new MongoDbBillingQueryRepository();
      const snapshots = new MongoDbBillingSnapshotRepository();
      const periods = new MongoDbBillingPeriodRepository();

      const result = await new CloseBillingPeriodDbUseCase({
        billingQueryRepository: queries,
        billingPeriodRepository: periods,
        billingSnapshotRepository: snapshots,
        traceRepository: traces,
        now: () => new Date('2026-07-15T10:00:00.000Z'),
      }).close(2026, 6);

      const stored = await snapshots.findCurrent(2026, 6);
      const storedInputs = await snapshots.findUsageRecords(2026, 6, 1);
      const wholeMonth = await queries.fetchUsageRecords(JUNE_START, JULY_START);

      // The premise of the whole case: the two readers really do answer in
      // the REVERSE of the order the close folded the month in.
      expect(storedInputs.map((record) => record.traceId)).toEqual([
        'a-tie-dear',
        'm-plain',
        'z-tie-cheap',
      ]);
      expect(wholeMonth.map((record) => record.traceId)).toEqual(
        storedInputs.map((record) => record.traceId),
      );
      expect(result.stampedTraceCount).toBe(3);

      const rebuilt = buildStatement(storedInputs);
      const live = buildStatement(wholeMonth);
      const lineOrder = (statement: typeof rebuilt) =>
        statement.lines.map((line) => [
          line.model,
          line.appliedPriceMicrocentsPerMillion,
        ]);

      // (1) T6 reproducibility, now actually load-bearing: the frozen
      // lines are in the SAME order the engine produces over the snapshot's
      // own stored inputs — which arrive in traceId order, not fold order.
      expect(lineOrder(stored?.statement as typeof rebuilt)).toEqual(
        lineOrder(rebuilt),
      );
      expect(lineOrder(rebuilt)).toEqual([
        ['anthropic/claude-sonnet-4-6', 2_500_000_000],
        ['anthropic/claude-x', 1_500_000],
        ['anthropic/claude-x', 2_500_000],
      ]);
      expect(JSON.parse(JSON.stringify(stored?.statement))).toEqual(
        JSON.parse(JSON.stringify(rebuilt)),
      );

      // (2) The twin comparator: `sortPriceVersions` has no agent term, so
      // this same fixture ties it on (model, tokenType, effectiveFrom) —
      // the applied price is the only thing left to order by.
      expect(
        JSON.parse(JSON.stringify(stored?.priceVersionsApplied)),
      ).toEqual(JSON.parse(JSON.stringify(collectAppliedPriceVersions(storedInputs))));
      expect(
        stored?.priceVersionsApplied.map((version) => [
          version.model,
          version.priceMicrocentsPerMillion,
        ]),
      ).toEqual([
        ['anthropic/claude-sonnet-4-6', 2_500_000_000],
        ['anthropic/claude-x', 1_500_000],
        ['anthropic/claude-x', 2_500_000],
      ]);

      // (3) The DISPLAYED centavos of the tie pair are the same frozen and
      // live. Both lines carry exactly half a centavo, so the largest-
      // remainder deficit of 1 goes to whichever of them sits at the lower
      // INDEX: with a partial comparator that index depended on the feed,
      // and the same line exported at R$ 0,02 open and R$ 0,01 frozen.
      const tieCents = (statement: typeof rebuilt) =>
        statement.lines
          .filter((line) => line.model === 'anthropic/claude-x')
          .map((line) => [
            line.appliedPriceMicrocentsPerMillion,
            line.displayCents,
          ]);

      expect(tieCents(stored?.statement as typeof rebuilt)).toEqual([
        [1_500_000, 2],
        [2_500_000, 2],
      ]);
      expect(tieCents(live)).toEqual(
        tieCents(stored?.statement as typeof rebuilt),
      );
      // Invariant 3 all the same: the parts still close with the total.
      expect(stored?.statement.totalCostMicrocents).toBe(2_504_000_000);
      expect(stored?.statement.totalDisplayCents).toBe(2_504);
      expect(
        stored?.statement.lines.reduce((sum, line) => sum + line.displayCents, 0),
      ).toBe(2_504);
      expect(await usageRows()).toBe(3);
    });

    it('the storage-only insert obeys the same rule: a duplicate header takes its staged rows with it', async () => {
      const sut = new MongoDbBillingSnapshotRepository();

      await sut.insert(makeSnapshot(1, [usageRecord({ traceId: 'i1' })]), [
        usageRecord({ traceId: 'i1' }),
      ]);

      // The unique (year, month, version) header index refuses the second
      // write AFTER its rows are staged — they must not outlive it.
      await expect(
        sut.insert(makeSnapshot(1, [usageRecord({ traceId: 'i2' })]), [
          usageRecord({ traceId: 'i2' }),
        ]),
      ).rejects.toThrow();

      expect(await usageRows()).toBe(1);
    });

    /**
     * The lost race's DETERMINISTIC shape lives in the conflict test above
     * ('...leaves NOTHING on disk'): a loser that arrives after the winner
     * closed computes v+1, so its staging area sits under a version prefix
     * NO later sweep will ever visit — the leak was unbounded in time. The
     * same-version race (both attempts compute v1) is the one case the old
     * sweep did cover, and only when the winner's sweep happens to run
     * last, which is why it is not asserted here as if it were a guarantee.
     */
  });
});
