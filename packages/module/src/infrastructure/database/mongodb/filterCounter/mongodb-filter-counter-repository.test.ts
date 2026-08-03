import { MongoDb } from '../mongo-db.js';
import { MongoDbFilterCounterRepository } from './mongodb-filter-counter-repository.js';
import { MongoDbTraceRepository } from '../trace/mongodb-trace-repository.js';
import {
  TRACES_COLLECTION,
  TRACE_FILTER_COUNTERS_COLLECTION,
} from '../collections.js';
import { TraceModel } from '../../../../domain/models/trace-model.js';
import { traceIndexes } from '../migrations/003-trace-indexes.js';

const makeTrace = (overrides: Partial<TraceModel> = {}): TraceModel => ({
  traceId: 'trace-cube-001',
  agent: { id: 'agent-a', version: '1.0.0', instance: 'agent-a-1' },
  model: { id: 'gpt-5-mini', provider: 'openai' },
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
  // Production-shaped stamp (audit C8): lines per token type, summing to
  // the total — the cube never reads money, but fixtures stay honest.
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

// Canonical order = the domain tuple, never a serialization of the doc:
// mongod does not guarantee BSON field order for upserted documents (it can
// differ per operation), and the $out rebuild writes yet another order — so
// a JSON.stringify sort key flips depending on which field happens to come
// first, making the incremental-vs-rebuilt comparison order-flaky.
const tupleKey = (row: Record<string, unknown>): string =>
  JSON.stringify([
    row['day'],
    row['domain'],
    row['subdomain'],
    row['type'],
    row['agentId'],
    row['channelType'],
    row['status'],
  ]);

const readCounters = async () => {
  const rows = await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION)
    .find({}, { projection: { _id: 0 } })
    .toArray();

  return rows.sort((a, b) => {
    const [keyA, keyB] = [tupleKey(a), tupleKey(b)];

    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
};

describe('MongoDbFilterCounterRepository (facet cube, decision 77)', () => {
  const traceRepository = new MongoDbTraceRepository();
  const counterRepository = new MongoDbFilterCounterRepository();

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
    // Exactly-once counting rides insertIfAbsent's idempotency, which is
    // anchored on the unique traceId index (audit C-7.3 removed the
    // pre-insert findOne) — run against the production schema.
    await traceIndexes.run(MongoDb.getClient().db());
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

  it('applyDelta on a DRIFTED cube MUST no-op the decrement, never go negative (audit C-7.4)', async () => {
    const dims = (agentId: string) => ({
      day: new Date('2026-06-05T00:00:00.000Z'),
      domain: 'varejo',
      subdomain: 'loja-sp',
      type: 'chat',
      agentId,
      channelType: 'whatsapp',
      status: 'ok' as const,
    });

    // Drift case 1: the before-tuple is MISSING entirely — the decrement
    // must not materialize a negative tuple.
    await counterRepository.applyDelta(dims('agent-missing'), dims('agent-b'));

    // Drift case 2: the before-tuple is a zero-count leftover (a previous
    // correction already moved the count away).
    await MongoDb.getCollection(TRACE_FILTER_COUNTERS_COLLECTION).insertOne({
      ...dims('agent-zero'),
      count: 0,
    });
    await counterRepository.applyDelta(dims('agent-zero'), dims('agent-b'));

    const counters = await readCounters();

    expect(
      counters.find((row) => row['agentId'] === 'agent-missing'),
    ).toBeUndefined();
    expect(counters.find((row) => row['agentId'] === 'agent-zero')).toMatchObject(
      { count: 0 },
    );
    // The increment side still lands: both corrections arrived at agent-b.
    expect(counters.find((row) => row['agentId'] === 'agent-b')).toMatchObject({
      count: 2,
    });
    // NO tuple anywhere went negative.
    expect(counters.every((row) => (row['count'] as number) >= 0)).toBe(true);
  });

  // THE incremental≡rebuild identity guard: the same traces applied through
  // the incremental write path (insertIfAbsent → toFilterCounterDims) and
  // through the extracted rebuild pipeline (filter-counter-pipeline.ts)
  // must land byte-identical tuple documents — the two derivations of the
  // cube can never drift.
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
