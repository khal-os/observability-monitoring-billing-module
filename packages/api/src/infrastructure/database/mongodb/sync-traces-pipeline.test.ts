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
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from './trace/mongodb-trace-repository.js';
import { FakeTraceSourceClient } from '../../traceSource/fake-trace-source-client.js';
import { SyncTracesToDbUseCase } from '../../../application/useCases/syncTraces/sync-traces-use-case.js';
import { ReprocessPendingToDbUseCase } from '../../../application/useCases/reprocessPending/reprocess-pending-use-case.js';
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
  const sut = new SyncTracesToDbUseCase({
    traceSourceClient: new FakeTraceSourceClient(),
    priceVersionRepository,
    traceRepository,
  });
  const reprocess = new ReprocessPendingToDbUseCase({
    priceVersionRepository,
    traceRepository,
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
    ]) {
      await MongoDb.getCollection(collection).deleteMany({});
    }

    await runMigrations(MongoDb.getClient().db(), migrations);
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
          priceMicrocentsPerMillion: brlToMicrocents(priceV1),
          effectiveFrom: JUNE_1,
        });
        await priceVersionRepository.insertVersion({
          model: 'meta/llama-4-scout',
          tokenType,
          priceMicrocentsPerMillion: brlToMicrocents(priceV2),
          effectiveFrom: JUNE_15,
        });
      }

      const report = await reprocess.reprocess();

      expect(report).toEqual({ examined: 2, stamped: 2, stillPending: 0 });

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

    it('MUST shrink the missing-types list as prices arrive, while staying pending (honesty refresh)', async () => {
      const { sut, reprocess, priceVersionRepository } = makeSut();

      await sut.sync(WINDOW_1);

      // Ingestion snapshot: both used token types lack a price.
      expect((await findTrace('trace-w1-006'))?.pendingPrice).toEqual({
        missingTokenTypes: ['input', 'output'],
      });

      // Only ONE of the two missing prices gets registered…
      await priceVersionRepository.insertVersion({
        model: 'meta/llama-4-scout',
        tokenType: 'input',
        priceMicrocentsPerMillion: brlToMicrocents('1.00'),
        effectiveFrom: JUNE_1,
      });

      const report = await reprocess.reprocess();

      // …so the trace stays pending (never partially stamped, invariant 2)
      // but the honesty companion now names only what is STILL missing.
      expect(report.stamped).toBe(0);
      const pending = await findTrace('trace-w1-006');

      expect(pending?.pricingStatus).toBe('pending_price');
      expect(pending?.totalCostMicrocents).toBeNull();
      expect(pending?.pendingPrice).toEqual({ missingTokenTypes: ['output'] });
    });
  });

  describe('Late-arriving model: attribution refresh makes the trace stampable (invariant 7)', () => {
    class MutableTraceSourceClient {
      traces: SourceTrace[] = [];

      async fetchTraces(): Promise<SourceTrace[]> {
        return this.traces;
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

      expect((stored as { model?: string })?.model).toBe('openai/gpt-5-mini');

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
});
