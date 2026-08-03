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
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../../domain/models/billing-snapshot-model.js';
import { BillingPeriodAuditEntry } from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodStateError } from '../../../../domain/useCases/close-billing-period-use-case.js';
import { buildStatement } from '../../../../application/useCases/billingStatement/statement-engine.js';
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

const JUNE_START = new Date('2026-06-01T00:00:00.000Z');
const JULY_START = new Date('2026-07-01T00:00:00.000Z');

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

      // The transaction rolled back: no orphan header, no orphan inputs,
      // period untouched — the exact opposite of the pre-fix wedge.
      expect(
        await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION).countDocuments({}),
      ).toBe(0);
      expect(
        await MongoDb.getCollection(
          BILLING_SNAPSHOT_USAGE_COLLECTION,
        ).countDocuments({}),
      ).toBe(0);
      expect(await periods.find(2026, 6)).toBeNull();

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

      expect(JSON.parse(JSON.stringify(buildStatement(storedInputs)))).toEqual(
        JSON.parse(JSON.stringify(stored?.statement)),
      );
    });

    it('an already-closed period answers conflict and writes NOTHING', async () => {
      const sut = new MongoDbBillingSnapshotRepository();
      const records = [usageRecord({ traceId: 'w1' })];

      await sut.insertWithPeriodClose(makeSnapshot(1, records), records, closeArgs(1));

      const late = [usageRecord({ traceId: 'l1' })];
      const outcome = await sut.insertWithPeriodClose(
        makeSnapshot(2, late),
        late,
        closeArgs(2),
      );

      expect(outcome).toBe('conflict');
      expect(await sut.findCurrent(2026, 6)).toMatchObject({ version: 1 });
      expect(await sut.findUsageRecords(2026, 6, 2)).toEqual([]);
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
      // winner's — no cross-contamination from the loser's rolled-back
      // writes — and they reproduce the winning statement.
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

    it('pendingPriceSummary counts pending APART — and unresolved-quarantined pending is OUTSIDE the close guard (M6, decision 100)', async () => {
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
      // Post-close straggler, still pending: the close of the REOPENED
      // month must not be blocked by it — it is outside the close's scope
      // (surfaced by countQuarantined; recovered only via the reopen flow).
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
      const summary = await sut.pendingPriceSummary(JUNE_START, JULY_START);

      expect(summary.traceCount).toBe(1);
      expect(summary.tokens).toEqual({
        input: 500,
        output: 100,
        cache_read: 0,
        cache_write: 0,
      });
      // Only the in-scope pending trace's model blocks the close.
      expect(summary.models).toEqual(['meta/llama-4-scout']);
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
      // Unresolved-quarantined pending: outside the bill — not in the
      // pending count, its tokens not in the live volume.
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
      const rows = await sut.listBills();

      expect(rows.map((row) => [row.year, row.month])).toEqual([
        [2026, 7],
        [2026, 6],
      ]);
      expect(rows[1]).toEqual({
        year: 2026,
        month: 6,
        totalCostMicrocents: 2_500_000_000,
        stampedTraceCount: 1,
        pendingTraceCount: 1, // the quarantined pending one is NOT here
        tokens: 1_000_000 + 300, // stamped + in-scope pending volume
        stampedTokens: 1_000_000, // billed volume only (B-10.4)
      });
      expect(rows[0]).toMatchObject({ tokens: 2_500, stampedTokens: 2_500 });

      // audit C-7.1: the bound cuts closed history out of the scan.
      const bounded = await sut.listBills(JULY_START);

      expect(bounded.map((row) => row.month)).toEqual([7]);
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
      const days = await sut.dailyRollup(JUNE_START, JULY_START);

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
      const days = await sut.dailyRollup(JUNE_START, JULY_START);

      expect(days).toHaveLength(1);
      expect(days[0]?.totalCostMicrocents).toBe(5_000_000_000);
    });
  });
});
