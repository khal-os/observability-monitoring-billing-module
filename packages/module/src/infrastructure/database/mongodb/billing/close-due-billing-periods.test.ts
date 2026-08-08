import { MongoDb } from '@observability/core/infrastructure/database/mongodb/mongo-db.js';
import {
  BILLING_PERIODS_COLLECTION,
  MongoDbBillingPeriodRepository,
} from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-period-repository.js';
import {
  BILLING_SNAPSHOTS_COLLECTION,
  BILLING_SNAPSHOT_USAGE_COLLECTION,
  MongoDbBillingSnapshotRepository,
} from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-snapshot-repository.js';
import { MongoDbBillingQueryRepository } from '@observability/core/infrastructure/database/mongodb/billing/mongodb-billing-query-repository.js';
import { MongoDbTraceRepository } from '@observability/core/infrastructure/database/mongodb/trace/mongodb-trace-repository.js';
import { TRACES_COLLECTION } from '@observability/core/infrastructure/database/mongodb/collections.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';
import { billingPeriodIndexes } from '@observability/core/infrastructure/database/mongodb/migrations/017-billing-period-indexes.js';
import { CloseBillingPeriodDbUseCase } from '../../../../application/useCases/billingLifecycle/close-billing-period-db-use-case.js';
import { CloseDueBillingPeriodsDbUseCase } from '../../../../application/useCases/billingLifecycle/close-due-billing-periods-db-use-case.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-sched-001',
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
      appliedPriceEffectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
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

const NOW = new Date('2026-07-15T10:00:00.000Z');
const HOUR_MS = 3_600_000;

const makeSut = () => {
  // The real composition, minus the factory (main is off-limits here):
  // the scheduler's close is the ONE use case, composed with 'scheduled'.
  const closeBillingPeriod = new CloseBillingPeriodDbUseCase({
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingSnapshotRepository: new MongoDbBillingSnapshotRepository(),
    traceRepository: new MongoDbTraceRepository(),
    now: () => NOW,
    trigger: 'scheduled',
  });

  return new CloseDueBillingPeriodsDbUseCase({
    billingPeriodRepository: new MongoDbBillingPeriodRepository(),
    billingQueryRepository: new MongoDbBillingQueryRepository(),
    closeBillingPeriod,
    delayMs: HOUR_MS,
    now: () => NOW,
  });
};

describe('CloseDueBillingPeriods (integration — decision 131 end to end)', () => {
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

  it("one cycle closes every overdue month oldest-first with trigger 'scheduled' persisted; the next cycle is a no-op", async () => {
    const traces = new MongoDbTraceRepository();
    await traces.insertIfAbsent(
      makeTrace({
        traceId: 'may-1',
        startedAt: new Date('2026-05-10T12:00:00.000Z'),
      }),
    );
    await traces.insertIfAbsent(
      makeTrace({
        traceId: 'june-1',
        startedAt: new Date('2026-06-05T14:00:00.000Z'),
      }),
    );

    const firstCycle = await makeSut().runCycle();

    expect(
      firstCycle.closed.map(({ year, month }) => ({ year, month })),
    ).toEqual([
      { year: 2026, month: 5 },
      { year: 2026, month: 6 },
    ]);
    expect(firstCycle.blocked).toBeUndefined();

    const periodRepository = new MongoDbBillingPeriodRepository();
    const snapshotRepository = new MongoDbBillingSnapshotRepository();

    for (const month of [5, 6]) {
      const period = await periodRepository.find(2026, month);
      const snapshot = await snapshotRepository.findCurrent(2026, month);

      expect(period?.status).toBe('closed');
      expect(period?.audit.at(-1)?.trigger).toBe('scheduled');
      expect(snapshot?.trigger).toBe('scheduled');
      expect(snapshot?.statement.stampedTraceCount).toBe(1);
    }

    // Reconcile means converge: the second wake finds nothing due.
    const secondCycle = await makeSut().runCycle();

    expect(secondCycle.closed).toEqual([]);
    expect(secondCycle.racedAlreadyClosed).toEqual([]);
    expect(secondCycle.nextCandidate).toEqual({
      year: 2026,
      month: 7,
      eligibleAt: new Date('2026-08-01T04:00:00.000Z'),
    });
  });
});
