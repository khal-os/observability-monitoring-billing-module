/**
 * End-to-end integration of the PoC core (T2-lite + T5): real fixtures,
 * real Mongo store, real price seed — including the two MANDATORY tests:
 * sync idempotency and price-stamp immutability (decision 25).
 */
import { MongoDb } from './mongo-db.js';
import {
  MIGRATIONS_COLLECTION,
  runMigrations,
} from './helpers/migration-runner.js';
import { migrations } from './migrations/index.js';
import {
  MongoDbPriceVersionRepository,
  PRICE_VERSIONS_COLLECTION,
} from './priceVersion/mongodb-price-version-repository.js';
import { seedPocPrices } from './priceVersion/poc-price-seed.js';
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from './trace/mongodb-trace-repository.js';
import { FakeTraceSourceClient } from '../../traceSource/fake-trace-source-client.js';
import { SyncTracesToDbUseCase } from '../../../application/useCases/syncTraces/sync-traces-use-case.js';
import { ReprocessPendingToDbUseCase } from '../../../application/useCases/reprocessPending/reprocess-pending-use-case.js';
import { CloseBillingPeriodDbUseCase } from '../../../application/useCases/billingLifecycle/close-billing-period-db-use-case.js';
import { ReopenBillingPeriodDbUseCase } from '../../../application/useCases/billingLifecycle/reopen-billing-period-db-use-case.js';
import { GetBillingSummaryDbUseCase } from '../../../application/useCases/billingSummary/get-billing-summary-db-use-case.js';
import {
  BILLING_PERIODS_COLLECTION,
  MongoDbBillingPeriodRepository,
} from './billing/mongodb-billing-period-repository.js';
import {
  BILLING_SNAPSHOTS_COLLECTION,
  BILLING_SNAPSHOT_USAGE_COLLECTION,
  MongoDbBillingSnapshotRepository,
} from './billing/mongodb-billing-snapshot-repository.js';
import { MongoDbBillingQueryRepository } from './billing/mongodb-billing-query-repository.js';
import { MongoDbIngestFailureRepository } from './ingestFailures/mongodb-ingest-failure-repository.js';
import { estimateBsonBytes } from './ingestFailures/bson-size-estimator.js';
import { GetTraceDetailDbUseCase } from '../../../application/useCases/queryTraces/get-trace-detail-db-use-case.js';
import { MongoDbTraceQueryRepository } from './trace/mongodb-trace-query-repository.js';
import { brlToMicrocents } from '../../../common/helpers/money/money.js';
import { StampedTokenCost } from '../../../domain/models/trace-model.js';
import { SourceTrace } from '../../../application/interfaces/trace-source-client.js';

const WINDOW_1 = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-06-15T00:00:00.000Z'),
};

const WINDOW_2 = {
  from: new Date('2026-06-15T00:00:00.000Z'),
  to: new Date('2026-07-01T00:00:00.000Z'),
};

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');
const JUNE_15 = new Date('2026-06-15T00:00:00.000Z');

interface StoredTrace {
  traceId: string;
  pricingStatus: string;
  stampedCosts?: StampedTokenCost[];
  totalCostMicrocents?: number;
  tokens?: Record<string, number>;
  pendingPrice?: { missingTokenTypes: string[] } | null;
}

const findTrace = async (traceId: string): Promise<StoredTrace | null> =>
  (await MongoDb.getCollection(TRACES_COLLECTION).findOne({
    traceId,
  })) as StoredTrace | null;

const makeSut = () => {
  const priceVersionRepository = new MongoDbPriceVersionRepository();
  const traceRepository = new MongoDbTraceRepository();
  const billingPeriodRepository = new MongoDbBillingPeriodRepository();
  const sut = new SyncTracesToDbUseCase({
    traceSourceClient: new FakeTraceSourceClient(),
    priceVersionRepository,
    traceRepository,
    billingPeriodRepository,
    ingestFailureRepository: new MongoDbIngestFailureRepository(),
    estimateDocumentBytes: estimateBsonBytes,
  });
  const reprocess = new ReprocessPendingToDbUseCase({
    priceVersionRepository,
    traceRepository,
    billingPeriodRepository,
  });

  return { sut, reprocess, priceVersionRepository };
};

describe('Sync + price stamping (integration)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  beforeEach(async () => {
    for (const collection of [
      TRACES_COLLECTION,
      PRICE_VERSIONS_COLLECTION,
      MIGRATIONS_COLLECTION,
      BILLING_PERIODS_COLLECTION,
      BILLING_SNAPSHOTS_COLLECTION,
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    ]) {
      await MongoDb.getCollection(collection).deleteMany({});
    }

    await runMigrations(MongoDb.getClient().db(), migrations);
    // Prices are no longer seeded by the migration chain (decision 74) —
    // seed them explicitly, like `make seed-prices` does in dev.
    await seedPocPrices(MongoDb.getClient().db());
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  describe('MANDATORY: idempotency', () => {
    it('MUST NOT double-count when the same window is synced twice', async () => {
      const { sut } = makeSut();

      const firstRun = await sut.sync(WINDOW_1);

      expect(firstRun.fetched).toBe(6);
      expect(firstRun.inserted).toBe(6);
      expect(firstRun.pendingPrice).toBe(1);

      const costsBefore = await MongoDb.getCollection(TRACES_COLLECTION)
        .find({}, { sort: { traceId: 1 } })
        .toArray();

      const secondRun = await sut.sync(WINDOW_1);

      expect(secondRun.inserted).toBe(0);
      expect(secondRun.skipped).toBe(6);

      const costsAfter = await MongoDb.getCollection(TRACES_COLLECTION)
        .find({}, { sort: { traceId: 1 } })
        .toArray();

      expect(costsAfter).toHaveLength(6);
      expect(
        costsAfter.map((trace) => trace.totalCostMicrocents ?? null),
      ).toEqual(costsBefore.map((trace) => trace.totalCostMicrocents ?? null));

      // Spans are embedded in the trace documents — 8 across the window,
      // not duplicated by the re-sync.
      expect(
        costsAfter.reduce(
          (sum, trace) => sum + (trace.spans?.length ?? 0),
          0,
        ),
      ).toBe(8);
    });
  });

  describe('Stamping as-of the trace date (QA19)', () => {
    it('MUST stamp each window with the price version effective on the trace date', async () => {
      const { sut } = makeSut();

      await sut.sync(WINDOW_1);
      await sut.sync(WINDOW_2);

      // Window 1 trace (June 5) → v1 prices (effective June 1)
      const beforeChange = await findTrace('trace-w1-001');

      expect(beforeChange?.pricingStatus).toBe('stamped');
      expect(beforeChange?.totalCostMicrocents).toBe(715_000);
      expect(
        beforeChange?.stampedCosts?.find(
          (cost) => cost.tokenType === 'input',
        )?.appliedPriceEffectiveFrom,
      ).toEqual(JUNE_1);

      // Window 2 trace (June 16) → v2 prices (effective June 15, seeded
      // mid-period change), including cache read/write
      const afterChange = await findTrace('trace-w2-001');

      expect(afterChange?.totalCostMicrocents).toBe(1_160_375);
      expect(
        afterChange?.stampedCosts?.find(
          (cost) => cost.tokenType === 'input',
        )?.appliedPriceMicrocentsPerMillion,
      ).toBe(brlToMicrocents('3.10'));
      expect(
        afterChange?.stampedCosts?.find(
          (cost) => cost.tokenType === 'input',
        )?.appliedPriceEffectiveFrom,
      ).toEqual(JUNE_15);
    });
  });

  describe('MANDATORY: stamp immutability (decision 25 / demo step 3)', () => {
    it('MUST keep old stamps byte-identical after a price change — only new traces get the new price', async () => {
      const { sut, priceVersionRepository } = makeSut();

      await sut.sync(WINDOW_1);

      const stampsBefore = (
        await MongoDb.getCollection(TRACES_COLLECTION)
          .find({}, { sort: { traceId: 1 } })
          .toArray()
      ).map((trace) => ({
        traceId: trace.traceId,
        stampedCosts: trace.stampedCosts ?? null,
        totalCostMicrocents: trace.totalCostMicrocents ?? null,
      }));

      // The admin registers a NEW price version (demo step 3)
      await priceVersionRepository.insertVersion({
        model: 'openai/gpt-5-mini',
        tokenType: 'input',
        pricingType: 'fixed_brl',
        priceMicrocentsPerMillion: brlToMicrocents('99.00'),
        effectiveFrom: new Date('2026-06-16T00:00:00.000Z'),
      });

      await sut.sync(WINDOW_2);
      await sut.sync(WINDOW_1); // re-sync must not re-price either

      const stampsAfter = (
        await MongoDb.getCollection(TRACES_COLLECTION)
          .find(
            { traceId: { $regex: '^trace-w1-' } },
            { sort: { traceId: 1 } },
          )
          .toArray()
      ).map((trace) => ({
        traceId: trace.traceId,
        stampedCosts: trace.stampedCosts ?? null,
        totalCostMicrocents: trace.totalCostMicrocents ?? null,
      }));

      expect(stampsAfter).toEqual(stampsBefore);

      // Only the NEW trace (June 16, after the new version) gets R$ 99/M
      const newTrace = await findTrace('trace-w2-001');

      expect(
        newTrace?.stampedCosts?.find((cost) => cost.tokenType === 'input')
          ?.appliedPriceMicrocentsPerMillion,
      ).toBe(brlToMicrocents('99.00'));
      expect(newTrace?.totalCostMicrocents).toBe(
        1500 * 9900 + 400 * 1240 + 1000 * 27.5 + 500 * 343.75,
      );
    });
  });

  describe('MANDATORY: pending_price is never R$ 0 (invariant 2)', () => {
    it('MUST keep tokens and leave cost OPEN for models without price', async () => {
      const { sut } = makeSut();

      await sut.sync(WINDOW_1);

      const pending = await findTrace('trace-w1-006');

      expect(pending?.pricingStatus).toBe('pending_price');
      expect(pending?.tokens).toEqual({ input: 5000, output: 800, cache_read: null, cache_write: null });
      expect(pending?.totalCostMicrocents).toBeNull();
      expect(pending?.stampedCosts).toBeNull();
    });
  });

  describe('Reprocess pending (demo step 7) — as-of rule preserved (QA19)', () => {
    it('MUST stamp pending traces with the price of THEIR date, not the latest', async () => {
      const { sut, reprocess, priceVersionRepository } = makeSut();

      await sut.sync(WINDOW_1);
      await sut.sync(WINDOW_2);

      const stampedBefore = new Map(
        (
          await MongoDb.getCollection(TRACES_COLLECTION)
            .find({ pricingStatus: 'stamped' })
            .toArray()
        ).map((trace) => [trace.traceId, trace.totalCostMicrocents]),
      );

      // The missing price arrives — with TWO versions, one per window
      for (const [tokenType, priceV1, priceV2] of [
        ['input', '1.00', '2.00'],
        ['output', '4.00', '8.00'],
      ] as const) {
        await priceVersionRepository.insertVersion({
          model: 'meta/llama-4-scout',
          tokenType,
          pricingType: 'fixed_brl',
          priceMicrocentsPerMillion: brlToMicrocents(priceV1),
          effectiveFrom: JUNE_1,
        });
        await priceVersionRepository.insertVersion({
          model: 'meta/llama-4-scout',
          tokenType,
          pricingType: 'fixed_brl',
          priceMicrocentsPerMillion: brlToMicrocents(priceV2),
          effectiveFrom: JUNE_15,
        });
      }

      const report = await reprocess.reprocess();

      expect(report).toEqual({
        blockedClosedMonth: 0,
        examined: 2,
        stamped: 2,
        stillPending: 0,
        failed: 0,
      });

      // June 10 trace → June 1 prices (NOT the June 15 ones)
      const stampedW1 = await findTrace('trace-w1-006');

      expect(stampedW1?.pricingStatus).toBe('stamped');
      expect(stampedW1?.totalCostMicrocents).toBe(5000 * 100 + 800 * 400);
      expect(
        stampedW1?.stampedCosts?.find((cost) => cost.tokenType === 'input')
          ?.appliedPriceEffectiveFrom,
      ).toEqual(JUNE_1);

      // June 20 trace → June 15 prices
      const stampedW2 = await findTrace('trace-w2-003');

      expect(stampedW2?.totalCostMicrocents).toBe(1000 * 200 + 300 * 800);

      // EVERY previously-stamped trace is untouched by reprocessing
      for (const [traceId, totalBefore] of stampedBefore) {
        expect((await findTrace(traceId))?.totalCostMicrocents).toBe(
          totalBefore,
        );
      }
    });

    it('MUST derive the missing-types list AT READ TIME — fresh the moment a price is registered, no job needed', async () => {
      const { sut, priceVersionRepository } = makeSut();
      const readTraceDetail = new GetTraceDetailDbUseCase({
        traceQueryRepository: new MongoDbTraceQueryRepository(),
        priceVersionRepository,
      });

      await sut.sync(WINDOW_1);

      // Nothing stored, everything derived: the document carries no
      // snapshot (decision 51 exception), the read computes it.
      expect((await findTrace('trace-w1-006'))?.pendingPrice ?? null).toBeNull();
      expect(
        (await readTraceDetail.get('trace-w1-006'))?.pendingPrice,
      ).toEqual({ missingTokenTypes: ['input', 'output'] });

      // Only ONE of the two missing prices gets registered…
      await priceVersionRepository.insertVersion({
        model: 'meta/llama-4-scout',
        tokenType: 'input',
        pricingType: 'fixed_brl',
        priceMicrocentsPerMillion: brlToMicrocents('1.00'),
        effectiveFrom: JUNE_1,
      });

      // …and the VERY NEXT read is already honest — no reprocess ran, the
      // trace stays pending (never partially stamped, invariant 2), but the
      // list names only what is STILL missing.
      const derived = await readTraceDetail.get('trace-w1-006');

      expect(derived?.pricingStatus).toBe('pending_price');
      expect(derived?.totalCostMicrocents ?? null).toBeNull();
      expect(derived?.pendingPrice).toEqual({ missingTokenTypes: ['output'] });
    });
  });

  describe('Late-arriving model: attribution refresh makes the trace stampable (invariant 7)', () => {
    class MutableTraceSourceClient {
      traces: SourceTrace[] = [];

      async *fetchTracesPaged(): AsyncIterable<SourceTrace[]> {
        if (this.traces.length > 0) {
          yield this.traces;
        }
      }
    }

    const makeLateModelTrace = (model?: string): SourceTrace => ({
      traceId: 'trace-late-model',
      sessionId: 'sess-late',
      agent: { id: 'agent-atendimento' },
      model,
      type: 'chat',
      channel: { type: 'web' },
      startedAt: new Date('2026-06-05T09:00:00.000Z'),
      finishedAt: new Date('2026-06-05T09:00:02.000Z'),
      status: 'ok',
      tokens: { input: 1000 },
      input: 'entrada',
      output: 'saída',
      spans: [],
    });

    it('MUST persist the model on re-sync and stamp on reprocess with the as-of price', async () => {
      const { reprocess, priceVersionRepository } = makeSut();
      const client = new MutableTraceSourceClient();
      const sut = new SyncTracesToDbUseCase({
        traceSourceClient: client,
        priceVersionRepository,
        traceRepository: new MongoDbTraceRepository(),
        billingPeriodRepository: new MongoDbBillingPeriodRepository(),
        ingestFailureRepository: new MongoDbIngestFailureRepository(),
        estimateDocumentBytes: estimateBsonBytes,
      });

      // First sync: the source does not report the model yet
      client.traces = [makeLateModelTrace(undefined)];
      await sut.sync(WINDOW_1);

      let stored = await findTrace('trace-late-model');

      expect(stored?.pricingStatus).toBe('pending_price');

      // Re-sync of the same window now carries the corrected model
      client.traces = [makeLateModelTrace('openai/gpt-5-mini')];
      await sut.sync(WINDOW_1);

      stored = await findTrace('trace-late-model');

      expect(
        (stored as { model?: { id: string; provider: string | null } })?.model,
      ).toEqual({ id: 'gpt-5-mini', provider: 'openai' });

      const report = await reprocess.reprocess();

      expect(report.stamped).toBe(1);

      stored = await findTrace('trace-late-model');

      expect(stored?.pricingStatus).toBe('stamped');
      // As-of June 5 → the seeded v1 price (R$ 2.75/M), not the June 15 one
      expect(stored?.totalCostMicrocents).toBe(1000 * 275);
      expect(
        stored?.stampedCosts?.find((cost) => cost.tokenType === 'input')
          ?.appliedPriceEffectiveFrom,
      ).toEqual(JUNE_1);
    });
  });

  describe('Decision 100 acceptance (M1): close → straggler quarantined → reopen → re-close absorbs', () => {
    const NOW = new Date('2026-07-15T10:00:00.000Z');
    const JULY_1 = new Date('2026-07-01T00:00:00.000Z');

    class MutableTraceSourceClient {
      traces: SourceTrace[] = [];

      async *fetchTracesPaged(): AsyncIterable<SourceTrace[]> {
        if (this.traces.length > 0) {
          yield this.traces;
        }
      }
    }

    const sourceTrace = (
      overrides: Partial<SourceTrace> & { traceId: string },
    ): SourceTrace => ({
      sessionId: 'sess-late',
      agent: { id: 'agent-atendimento' },
      model: 'openai/gpt-5-mini',
      type: 'chat',
      channel: { type: 'web' },
      startedAt: new Date('2026-06-07T09:00:00.000Z'),
      finishedAt: new Date('2026-06-07T09:00:02.000Z'),
      status: 'ok',
      tokens: { input: 1000 },
      input: 'entrada',
      output: 'saída',
      spans: [],
      ...overrides,
    });

    const makeBillingSut = () => {
      const billingQueryRepository = new MongoDbBillingQueryRepository();
      const billingPeriodRepository = new MongoDbBillingPeriodRepository();
      const billingSnapshotRepository = new MongoDbBillingSnapshotRepository();
      const traceRepository = new MongoDbTraceRepository();

      const close = new CloseBillingPeriodDbUseCase({
        billingQueryRepository,
        billingPeriodRepository,
        billingSnapshotRepository,
        traceRepository,
        now: () => NOW,
      });
      const reopen = new ReopenBillingPeriodDbUseCase({
        billingPeriodRepository,
        now: () => NOW,
      });
      const summary = new GetBillingSummaryDbUseCase({
        billingQueryRepository,
        billingPeriodRepository,
        billingSnapshotRepository,
        now: () => NOW,
      });
      const lateSyncClient = new MutableTraceSourceClient();
      const lateSync = new SyncTracesToDbUseCase({
        traceSourceClient: lateSyncClient,
        priceVersionRepository: new MongoDbPriceVersionRepository(),
        traceRepository,
        billingPeriodRepository,
        ingestFailureRepository: new MongoDbIngestFailureRepository(),
        estimateDocumentBytes: estimateBsonBytes,
      });

      return {
        close,
        reopen,
        summary,
        lateSync,
        lateSyncClient,
        billingQueryRepository,
      };
    };

    const dailyRollupTotal = async (
      billingQueryRepository: MongoDbBillingQueryRepository,
    ): Promise<number> =>
      (await billingQueryRepository.dailyRollup(JUNE_1, JULY_1)).reduce(
        (sum, day) => sum + day.totalCostMicrocents,
        0,
      );

    it('runs the WHOLE correction flow: frozen bill honest throughout, days ≡ bill in every state, quarantine resolved by absorption', async () => {
      const { sut, reprocess, priceVersionRepository } = makeSut();
      const billing = makeBillingSut();

      // ARRANGE: June fully synced and fully stamped (the pending llama
      // traces get their prices — a close is blocked while any pending
      // trace exists).
      await sut.sync(WINDOW_1);
      await sut.sync(WINDOW_2);

      for (const tokenType of ['input', 'output'] as const) {
        await priceVersionRepository.insertVersion({
          model: 'meta/llama-4-scout',
          tokenType,
          pricingType: 'fixed_brl',
          priceMicrocentsPerMillion: brlToMicrocents('1.00'),
          effectiveFrom: JUNE_1,
        });
      }
      await reprocess.reprocess();

      // ACT 1 — close June (v1).
      const closed = await billing.close.close(2026, 6);

      expect(closed.snapshotVersion).toBe(1);
      // No straggler existed yet: nothing to flag, nothing to absorb.
      expect(closed.quarantine).toEqual({ flaggedStragglers: 0, absorbed: 0 });

      const v1Total = closed.totalCostMicrocents;

      // Days ≡ frozen bill right after the close (decision 97).
      expect(await dailyRollupTotal(billing.billingQueryRepository)).toBe(
        v1Total,
      );

      // ACT 2 — a LATE June trace arrives (plus a July one in the same
      // batch, which must stay untouched).
      billing.lateSyncClient.traces = [
        sourceTrace({ traceId: 'trace-late-june' }),
        sourceTrace({
          traceId: 'trace-july-ok',
          startedAt: new Date('2026-07-02T09:00:00.000Z'),
          finishedAt: new Date('2026-07-02T09:00:01.000Z'),
        }),
      ];

      const lateReport = await billing.lateSync.sync({
        from: JUNE_1,
        to: new Date('2026-07-10T00:00:00.000Z'),
      });

      expect(lateReport.quarantined).toBe(1);

      const lateStored = (await MongoDb.getCollection(
        TRACES_COLLECTION,
      ).findOne({ traceId: 'trace-late-june' })) as {
        billingQuarantine?: { reason: string } | null;
        pricingStatus?: string;
      } | null;
      const julyStored = (await MongoDb.getCollection(
        TRACES_COLLECTION,
      ).findOne({ traceId: 'trace-july-ok' })) as {
        billingQuarantine?: unknown;
      } | null;

      expect(lateStored?.billingQuarantine).toMatchObject({
        reason: 'period_closed',
      });
      expect(lateStored?.pricingStatus).toBe('stamped'); // priced, not billed
      expect(julyStored?.billingQuarantine ?? null).toBeNull();

      // A RE-SYNC of the quarantined trace must NOT refresh attribution —
      // the month is frozen; corrections go through the audited reopen.
      billing.lateSyncClient.traces = [
        sourceTrace({
          traceId: 'trace-late-june',
          agent: { id: 'agent-drifted' },
        }),
      ];
      await billing.lateSync.sync({
        from: JUNE_1,
        to: new Date('2026-07-10T00:00:00.000Z'),
      });

      const afterResync = (await MongoDb.getCollection(
        TRACES_COLLECTION,
      ).findOne({ traceId: 'trace-late-june' })) as {
        agent?: { id?: string };
      } | null;

      expect(afterResync?.agent?.id).toBe('agent-atendimento');

      // ASSERT 2 — the frozen bill is UNCHANGED; the straggler is visible
      // as quarantined, not silently billed and not silently dropped.
      const summaryAfterLate = await billing.summary.get(2026, 6);

      expect(summaryAfterLate.periodStatus).toBe('closed');
      expect(summaryAfterLate.statement.totalCostMicrocents).toBe(v1Total);
      expect(summaryAfterLate.quarantinedTraceCount).toBe(1);
      // Days still ≡ the frozen bill (the unresolved straggler is out).
      expect(await dailyRollupTotal(billing.billingQueryRepository)).toBe(
        v1Total,
      );

      // ACT 3 — the documented correction flow (decision 89): reopen,
      // re-close. The re-close bills the straggler and ABSORBS its flag.
      await billing.reopen.reopen(2026, 6, 'faturar retardatário de junho');

      const reclosed = await billing.close.close(2026, 6);

      expect(reclosed.snapshotVersion).toBe(2);
      expect(reclosed.quarantine.absorbed).toBe(1);
      expect(reclosed.totalCostMicrocents).toBe(v1Total + 1000 * 275);

      // ASSERT 3 — decision 100 acceptance: Σ dailyRollup(June) ≡ v2
      // statement total AND countQuarantined === 0.
      const summaryV2 = await billing.summary.get(2026, 6);

      expect(summaryV2.snapshotVersion).toBe(2);
      expect(summaryV2.statement.totalCostMicrocents).toBe(
        reclosed.totalCostMicrocents,
      );
      expect(await dailyRollupTotal(billing.billingQueryRepository)).toBe(
        reclosed.totalCostMicrocents,
      );
      expect(
        await billing.billingQueryRepository.countQuarantined(JUNE_1, JULY_1),
      ).toBe(0);
      expect(summaryV2.quarantinedTraceCount).toBe(0);

      // The historical mark survives absorption (decision 100: the mark is
      // never deleted — it just stops meaning "outside the bill").
      const absorbed = (await MongoDb.getCollection(TRACES_COLLECTION).findOne({
        traceId: 'trace-late-june',
      })) as {
        billingQuarantine?: {
          reason: string;
          absorbedInSnapshotVersion?: number;
        } | null;
      } | null;

      expect(absorbed?.billingQuarantine).toMatchObject({
        reason: 'period_closed',
        absorbedInSnapshotVersion: 2,
      });

      // Both snapshot versions are preserved (T6 audit trail).
      expect(summaryV2.snapshotVersions?.map((entry) => entry.version)).toEqual(
        [1, 2],
      );
    }, 30_000);
  });
});
