import { MongoDb } from '../mongo-db.js';
import {
  MongoDbFilterCounterRepository,
  TRACE_FILTER_COUNTERS_COLLECTION,
} from './mongodb-filter-counter-repository.js';
import {
  MongoDbTraceRepository,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-cube-001',
  agent: { id: 'agent-a', version: '1.0.0', instance: 'agent-a-1' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp', version: '3.2.0' },
  domain: 'varejo',
  subdomain: 'loja-sp',
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 100, output: 50 },
  tokensTotal: 150,
  pricingStatus: 'stamped',
  stampedCosts: [],
  totalCostMicrocents: 0,
  stampedAt: new Date('2026-06-05T14:01:00.000Z'),
  ingestedAt: new Date('2026-06-05T14:01:00.000Z'),
  input: 'in',
  output: 'out',
  spans: [],
  ...overrides,
});

const readCounters = async () => {
  const rows = await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION)
    .find({}, { projection: { _id: 0 } })
    .toArray();

  return rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
};

describe('MongoDbFilterCounterRepository (facet cube, decision 77)', () => {
  const traceRepository = new MongoDbTraceRepository();
  const counterRepository = new MongoDbFilterCounterRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION).deleteMany(
      {},
    );
  });

  it('MUST count a trace exactly once across repeated ingestions', async () => {
    await traceRepository.insertIfAbsent(makeTrace());
    await traceRepository.insertIfAbsent(makeTrace());

    const counters = await readCounters();

    expect(counters).toEqual([
      {
        day: new Date('2026-06-05T00:00:00.000Z'),
        domain: 'varejo',
        subdomain: 'loja-sp',
        type: 'chat',
        agentId: 'agent-a',
        channelType: 'whatsapp',
        status: 'ok',
        count: 1,
      },
    ]);
  });

  it('MUST move the count across tuples on an attribution correction (invariant 7)', async () => {
    await traceRepository.insertIfAbsent(makeTrace());

    await traceRepository.updateAttribution('trace-cube-001', {
      agent: { id: 'agent-b' },
      domain: 'financeiro',
      subdomain: 'cobranca',
    });

    const counters = await readCounters();
    const oldTuple = counters.find((row) => row['agentId'] === 'agent-a');
    const newTuple = counters.find((row) => row['agentId'] === 'agent-b');

    expect(oldTuple?.['count']).toBe(0);
    expect(newTuple).toMatchObject({
      domain: 'financeiro',
      subdomain: 'cobranca',
      agentId: 'agent-b',
      count: 1,
    });
  });

  it('MUST rebuild the cube from traces to exactly the incremental state', async () => {
    await traceRepository.insertIfAbsent(makeTrace());
    await traceRepository.insertIfAbsent(
      makeTrace({ traceId: 'trace-cube-002', status: 'error' }),
    );
    await traceRepository.insertIfAbsent(
      makeTrace({
        traceId: 'trace-cube-003',
        agent: undefined,
        domain: undefined,
        subdomain: undefined,
        startedAt: new Date('2026-06-06T10:00:00.000Z'),
      }),
    );

    const incremental = await readCounters();

    // Corrupt the cube, then prove the rebuild restores ground truth.
    await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION).updateMany(
      {},
      { $inc: { count: 41 } },
    );

    const tuples = await counterRepository.rebuildFromTraces();

    expect(tuples).toBe(3);
    expect(await readCounters()).toEqual(incremental);
  });
});
