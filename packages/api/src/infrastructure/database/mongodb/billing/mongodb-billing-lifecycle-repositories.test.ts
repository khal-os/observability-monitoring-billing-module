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
import { BillingSnapshotModel } from '../../../../domain/models/billing-snapshot-model.js';
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
  });
});
