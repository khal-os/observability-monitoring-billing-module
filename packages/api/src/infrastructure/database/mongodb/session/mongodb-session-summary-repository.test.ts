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
  stampedCosts: [],
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

    await traceRepository.stampPendingTrace('trace-pending', {
      stampedCosts: [],
      totalCostMicrocents: 777_000,
      stampedAt: new Date('2026-06-06T00:00:00.000Z'),
    });

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
});
