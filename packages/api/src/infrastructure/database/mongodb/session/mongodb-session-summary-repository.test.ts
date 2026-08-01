import { Collection, Document } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';
import {
  SESSION_SUMMARIES_COLLECTION,
  MongoDbSessionSummaryRepository,
  readSessionSummary,
} from './mongodb-session-summary-repository.js';
import { MongoDbSessionQueryRepository } from './mongodb-session-query-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';

// Fixtures are PRODUCTION-SHAPED (audit C8): a stamped trace carries one
// stamped-cost line per token type and the lines SUM to the total — never
// an empty stampedCosts next to a nonzero total, which no ingestion path
// can produce (invariant 3 tests elsewhere rely on exactly this shape).
const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-001',
  sessionId: 'sess-001',
  agent: { id: 'agent-a', version: '1.0.0', instance: 'agent-a-1' },
  model: { id: 'gpt-5-mini', provider: 'openai' },
  type: 'chat',
  channel: { type: 'whatsapp', version: '3.2.0' },
  domain: 'varejo',
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 100, output: 50 },
  tokensTotal: 150,
  pricingStatus: 'stamped',
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 100,
      appliedPriceMicrocentsPerMillion: 1_000_000_000,
      appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      costMicrocents: 100_000,
    },
    {
      tokenType: 'output',
      tokens: 50,
      appliedPriceMicrocentsPerMillion: 3_000_000_000,
      appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      costMicrocents: 150_000,
    },
  ],
  totalCostMicrocents: 250_000,
  stampedAt: new Date('2026-06-05T14:01:00.000Z'),
  ingestedAt: new Date('2026-06-05T14:01:00.000Z'),
  input: 'in',
  output: 'out',
  spans: [],
  ...overrides,
});

const makePendingTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  ...makeTrace(),
  traceId: 'trace-pending',
  pricingStatus: 'pending_price',
  stampedCosts: undefined,
  totalCostMicrocents: undefined,
  stampedAt: undefined,
  pendingPrice: { missingTokenTypes: ['input'] },
  ...overrides,
});

describe('MongoDbSessionSummaryRepository (materialized read-model, decision 80)', () => {
  const traceRepository = new MongoDbTraceRepository();
  const summaryRepository = new MongoDbSessionSummaryRepository();
  const queryRepository = new MongoDbSessionQueryRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION).deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('MUST materialize the summary on insert — GROUND TRUTH recomputed in plain JS, not via the pipeline under test', async () => {
    await traceRepository.insertIfAbsent(makeTrace());
    await traceRepository.insertIfAbsent(
      makeTrace({
        traceId: 'trace-002',
        startedAt: new Date('2026-06-05T15:00:00.000Z'),
        finishedAt: new Date('2026-06-05T15:00:06.000Z'),
        durationMs: 6000,
        status: 'error',
        tokens: { input: 30, output: 20 },
        tokensTotal: 50,
        stampedCosts: [
          {
            tokenType: 'input',
            tokens: 30,
            appliedPriceMicrocentsPerMillion: 2_000_000_000,
            appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
            costMicrocents: 60_000,
          },
          {
            tokenType: 'output',
            tokens: 20,
            appliedPriceMicrocentsPerMillion: 2_000_000_000,
            appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
            costMicrocents: 40_000,
          },
        ],
        totalCostMicrocents: 100_000,
        agent: { id: 'agent-b', version: '2.0.0', instance: 'agent-b-1' },
      }),
    );

    const summary = await readSessionSummary('sess-001');

    // Independent recomputation: sums typed by hand from the fixtures.
    expect(summary).toMatchObject({
      sessionId: 'sess-001',
      traceCount: 2,
      errorCount: 1,
      status: 'error',
      totalDurationMs: 10_000,
      tokensInput: 130,
      tokensOutput: 70,
      stampedCostMicrocents: 350_000,
      pendingPriceCount: 0,
      // First-trace block = the EARLIEST trace's fields (agent-a).
      agent: { id: 'agent-a', version: '1.0.0', instance: 'agent-a-1' },
      startedAt: new Date('2026-06-05T14:00:00.000Z'),
      lastActivityAt: new Date('2026-06-05T15:00:06.000Z'),
    });
  });

  it('MUST refresh cost and pending count when a pending trace is stamped', async () => {
    await traceRepository.insertIfAbsent(makePendingTrace());

    expect(await readSessionSummary('sess-001')).toMatchObject({
      pendingPriceCount: 1,
      stampedCostMicrocents: 0,
    });

    await traceRepository.stampPendingTrace(
      'trace-pending',
      {
        stampedCosts: [
          {
            tokenType: 'input',
            tokens: 100,
            appliedPriceMicrocentsPerMillion: 5_000_000_000,
            appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
            costMicrocents: 500_000,
          },
          {
            tokenType: 'output',
            tokens: 50,
            appliedPriceMicrocentsPerMillion: 5_540_000_000,
            appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
            costMicrocents: 277_000,
          },
        ],
        totalCostMicrocents: 777_000,
        stampedAt: new Date('2026-06-06T00:00:00.000Z'),
      },
      // B-5 CAS pin: the model the prices were resolved for.
      { id: 'gpt-5-mini', provider: 'openai' },
    );

    expect(await readSessionSummary('sess-001')).toMatchObject({
      pendingPriceCount: 0,
      stampedCostMicrocents: 777_000,
    });
  });

  it('MUST refresh the first-trace block on an attribution change', async () => {
    await traceRepository.insertIfAbsent(makeTrace());

    await traceRepository.updateAttribution('trace-001', {
      agent: { id: 'agent-corrigido' },
    });

    expect(await readSessionSummary('sess-001')).toMatchObject({
      agent: { id: 'agent-corrigido', version: null, instance: null },
    });
  });

  it('MUST NOT materialize sessionless traces', async () => {
    await traceRepository.insertIfAbsent(
      makeTrace({ traceId: 'trace-solo', sessionId: undefined }),
    );

    const count = await MongoDb.getCollection(
      SESSION_SUMMARIES_COLLECTION,
    ).countDocuments({});

    expect(count).toBe(0);
  });

  it('rebuildFromTraces MUST reproduce exactly what recompute-on-touch maintained', async () => {
    await traceRepository.insertIfAbsent(makeTrace());
    await traceRepository.insertIfAbsent(
      makeTrace({ traceId: 'trace-002', sessionId: 'sess-002' }),
    );
    await traceRepository.insertIfAbsent(makePendingTrace());

    const maintained = await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION)
      .find({}, { sort: { _id: 1 } })
      .toArray();

    await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION).deleteMany({});
    await summaryRepository.rebuildFromTraces();

    const rebuilt = await MongoDb.getCollection(SESSION_SUMMARIES_COLLECTION)
      .find({}, { sort: { _id: 1 } })
      .toArray();

    expect(rebuilt).toEqual(maintained);
  });

  it('findSessions MUST serve from the materialized collection with capped semantics intact', async () => {
    await traceRepository.insertIfAbsent(makeTrace());
    await traceRepository.insertIfAbsent(
      makeTrace({
        traceId: 'trace-002',
        sessionId: 'sess-002',
        startedAt: new Date('2026-06-06T10:00:00.000Z'),
      }),
    );

    const page = await queryRepository.findSessions(
      {},
      { page: 1, pageSize: 10 },
    );

    expect(page.total).toBe(2);
    expect(page.totalCapped).toBe(false);
    // Sorted by session start desc.
    expect(page.items.map((item) => item.sessionId)).toEqual([
      'sess-002',
      'sess-001',
    ]);
  });

  // ── audit B-6: two legal writers (worker + manual sync), no single-writer
  //    assumption. The recompute is one server-side $merge pipeline, so a
  //    recompute always lands the aggregate of ALL traces visible at its
  //    read — never a client-side stale snapshot written after a fresher one.

  it('recompute after concurrent inserts MUST land the aggregate of ALL current traces', async () => {
    const traces = Array.from({ length: 8 }, (_, index) =>
      makeTrace({
        traceId: `trace-conc-${index}`,
        startedAt: new Date(Date.UTC(2026, 5, 5, 14, index)),
        finishedAt: new Date(Date.UTC(2026, 5, 5, 14, index, 4)),
      }),
    );

    // Overlapping writers: every insert triggers its own recompute, all
    // interleaved. Whatever that interleaving did, the next touch derives
    // the full truth again.
    await Promise.all(
      traces.map((trace) => traceRepository.insertIfAbsent(trace)),
    );
    await Promise.all([
      summaryRepository.recompute('sess-001'),
      summaryRepository.recompute('sess-001'),
    ]);

    expect(await readSessionSummary('sess-001')).toMatchObject({
      traceCount: 8,
      errorCount: 0,
      tokensInput: 800,
      tokensOutput: 400,
      stampedCostMicrocents: 8 * 250_000,
      startedAt: new Date(Date.UTC(2026, 5, 5, 14, 0)),
      agent: { id: 'agent-a', version: '1.0.0', instance: 'agent-a-1' },
    });
  });

  it('MUST retry ONCE when the $merge upsert races into E11000, and land the correct summary', async () => {
    // Seed without triggering recompute: raw inserts.
    await MongoDb.getCollection(TRACES_COLLECTION).insertMany([
      makeTrace() as unknown as Document,
      makeTrace({ traceId: 'trace-002' }) as unknown as Document,
    ]);

    const realGetCollection = MongoDb.getCollection.bind(MongoDb);
    let aggregateCalls = 0;
    let injected = false;

    jest
      .spyOn(MongoDb, 'getCollection')
      .mockImplementation((name: string): Collection<Document> => {
        const collection = realGetCollection(name);

        if (name !== TRACES_COLLECTION) {
          return collection;
        }

        return new Proxy(collection, {
          get(target, property, receiver) {
            if (property !== 'aggregate') {
              const value = Reflect.get(target, property, receiver);

              return typeof value === 'function' ? value.bind(target) : value;
            }

            return (...args: unknown[]) => {
              aggregateCalls += 1;

              if (!injected) {
                injected = true;

                return {
                  toArray: async () => {
                    // The duplicate-key shape the server raises when two
                    // first-touch $merge inserts race on the same _id.
                    const error = new Error(
                      'E11000 duplicate key error (simulated two-writer race)',
                    );
                    (error as unknown as { code: number }).code = 11000;
                    throw error;
                  },
                };
              }

              return (
                target.aggregate as (...a: unknown[]) => unknown
              ).apply(target, args);
            };
          },
        });
      });

    await summaryRepository.recompute('sess-001');

    jest.restoreAllMocks();

    expect(aggregateCalls).toBe(2);
    expect(await readSessionSummary('sess-001')).toMatchObject({
      traceCount: 2,
      stampedCostMicrocents: 500_000,
    });
  });

  it('MUST NOT retry (and MUST propagate) non-duplicate-key recompute failures', async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).insertMany([
      makeTrace() as unknown as Document,
    ]);

    const realGetCollection = MongoDb.getCollection.bind(MongoDb);
    let aggregateCalls = 0;

    jest
      .spyOn(MongoDb, 'getCollection')
      .mockImplementation((name: string): Collection<Document> => {
        const collection = realGetCollection(name);

        if (name !== TRACES_COLLECTION) {
          return collection;
        }

        return new Proxy(collection, {
          get(target, property, receiver) {
            if (property !== 'aggregate') {
              const value = Reflect.get(target, property, receiver);

              return typeof value === 'function' ? value.bind(target) : value;
            }

            return () => {
              aggregateCalls += 1;

              return {
                toArray: async () => {
                  throw new Error('network blip (not a duplicate key)');
                },
              };
            };
          },
        });
      });

    await expect(summaryRepository.recompute('sess-001')).rejects.toThrow(
      'network blip',
    );

    expect(aggregateCalls).toBe(1);
  });
});
