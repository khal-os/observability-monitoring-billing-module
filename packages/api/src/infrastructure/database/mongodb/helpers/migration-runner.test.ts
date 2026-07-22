import { MongoDb } from '../mongo-db.js';
import {
  Migration,
  MIGRATIONS_COLLECTION,
  runMigrations,
} from './migration-runner.js';
import { priceVersionIndexes } from '../migrations/001-price-version-indexes.js';
import { seedPriceVersions } from '../migrations/002-seed-price-versions.js';
import { agentChannelBlocks } from '../migrations/004-agent-channel-blocks.js';
import { nullOptionals } from '../migrations/005-null-optionals.js';
import { embedSpans } from '../migrations/006-embed-spans.js';
import { mergeSpanContents } from '../migrations/007-merge-span-contents.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';
import {
  LEGACY_SPANS_COLLECTION,
  LEGACY_TRACE_CONTENTS_COLLECTION,
  TRACES_COLLECTION,
} from '../trace/mongodb-trace-repository.js';

const SCRATCH_COLLECTION = 'migration_runner_scratch';

const makeMigration = (id: string, log: string[]): Migration => ({
  id,
  async run(db) {
    log.push(id);
    await db.collection(SCRATCH_COLLECTION).insertOne({ ranMigration: id });
  },
});

describe('runMigrations()', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(MIGRATIONS_COLLECTION).deleteMany({});
    await MongoDb.getCollection(SCRATCH_COLLECTION).deleteMany({});
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  it('MUST apply migrations once, in order, and record them', async () => {
    const log: string[] = [];
    const migrations = [makeMigration('001-a', log), makeMigration('002-b', log)];
    const db = MongoDb.getClient().db();

    const applied = await runMigrations(db, migrations);

    expect(applied).toEqual(['001-a', '002-b']);
    expect(log).toEqual(['001-a', '002-b']);

    const records = await MongoDb.getCollection(MIGRATIONS_COLLECTION)
      .find({})
      .toArray();

    expect(records.map((record) => record.id).sort()).toEqual([
      '001-a',
      '002-b',
    ]);
  });

  it('MUST be idempotent: a second run applies nothing', async () => {
    const log: string[] = [];
    const migrations = [makeMigration('001-a', log)];
    const db = MongoDb.getClient().db();

    await runMigrations(db, migrations);
    const secondRun = await runMigrations(db, migrations);

    expect(secondRun).toEqual([]);
    expect(log).toEqual(['001-a']);
  });

  it('MUST apply only migrations not yet recorded', async () => {
    const log: string[] = [];
    const db = MongoDb.getClient().db();

    await runMigrations(db, [makeMigration('001-a', log)]);
    const applied = await runMigrations(db, [
      makeMigration('001-a', log),
      makeMigration('002-b', log),
    ]);

    expect(applied).toEqual(['002-b']);
    expect(log).toEqual(['001-a', '002-b']);
  });

  it('MUST survive a crash between run and record: the real migrations are idempotent', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(PRICE_VERSIONS_COLLECTION).deleteMany({});
    await runMigrations(db, [priceVersionIndexes, seedPriceVersions]);

    const seededCount = await db
      .collection(PRICE_VERSIONS_COLLECTION)
      .countDocuments();

    // Simulates the crash window: the seed ran but was never recorded, so
    // the next `npm run migrate` re-executes it against seeded data.
    await expect(seedPriceVersions.run(db)).resolves.not.toThrow();

    expect(
      await db.collection(PRICE_VERSIONS_COLLECTION).countDocuments(),
    ).toBe(seededCount);
  });

  it('MUST reshape legacy agentId/channel strings into blocks without touching stamps (004)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(TRACES_COLLECTION).deleteMany({});
    await db.collection(TRACES_COLLECTION).insertOne({
      traceId: 'legacy-1',
      agentId: 'agent-x',
      channel: 'whatsapp',
      pricingStatus: 'stamped',
      totalCostMicrocents: 123_456,
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    await agentChannelBlocks.run(db);
    await agentChannelBlocks.run(db); // idempotent re-run

    const reshaped = await db
      .collection(TRACES_COLLECTION)
      .findOne({ traceId: 'legacy-1' });

    expect(reshaped?.agent).toEqual({ id: 'agent-x' });
    expect(reshaped).not.toHaveProperty('agentId');
    expect(reshaped?.channel).toEqual({ type: 'whatsapp' });
    expect(reshaped?.totalCostMicrocents).toBe(123_456);

    await db.collection(TRACES_COLLECTION).deleteMany({});
  });

  it('MUST backfill nulls for optional fields on legacy documents (005)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(TRACES_COLLECTION).deleteMany({});
    await db.collection(TRACES_COLLECTION).insertOne({
      traceId: 'legacy-2',
      agent: { id: 'agent-x' },
      channel: { type: 'web' },
      pricingStatus: 'stamped',
      totalCostMicrocents: 500,
      tokens: { input: 10 },
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });

    await nullOptionals.run(db);
    await nullOptionals.run(db); // idempotent re-run

    const uniform = await db
      .collection(TRACES_COLLECTION)
      .findOne({ traceId: 'legacy-2' });

    expect(uniform?.sessionId).toBeNull();
    expect(uniform?.model).toBeNull();
    expect(uniform?.agent).toEqual({ id: 'agent-x', version: null, instance: null });
    expect(uniform?.channel).toEqual({ type: 'web', version: null, instance: null });
    expect(uniform?.tokens).toEqual({
      input: 10,
      output: null,
      cache_read: null,
      cache_write: null,
    });
    expect(uniform?.stampedCosts).toBeNull();
    expect(uniform?.totalCostMicrocents).toBe(500); // stamp untouched

    await db.collection(TRACES_COLLECTION).deleteMany({});
  });

  it('MUST embed legacy spans into the content document and drop the collection (006)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).deleteMany({});
    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).insertOne({
      traceId: 'legacy-3',
      input: 'oi',
      output: 'olá',
      spanContents: [],
    });
    await db.collection(LEGACY_SPANS_COLLECTION).insertMany([
      {
        spanId: 'span-b',
        traceId: 'legacy-3',
        type: 'tool',
        name: 'consulta',
        startedAt: new Date('2026-06-01T00:00:02.000Z'),
        finishedAt: new Date('2026-06-01T00:00:03.000Z'),
        durationMs: 1000,
        status: 'ok',
      },
      {
        spanId: 'span-a',
        traceId: 'legacy-3',
        type: 'llm',
        name: 'gpt-5-mini',
        startedAt: new Date('2026-06-01T00:00:00.000Z'),
        finishedAt: new Date('2026-06-01T00:00:01.000Z'),
        durationMs: 1000,
        status: 'ok',
      },
    ]);

    await embedSpans.run(db);
    await embedSpans.run(db); // idempotent re-run

    const content = await db
      .collection(LEGACY_TRACE_CONTENTS_COLLECTION)
      .findOne({ traceId: 'legacy-3' });

    // Chronological order, no _id/traceId noise inside the embedded spans
    expect(content?.spans.map((span: { spanId: string }) => span.spanId)).toEqual(
      ['span-a', 'span-b'],
    );
    expect(content?.spans[0]).not.toHaveProperty('traceId');
    expect(content?.spans[0]).not.toHaveProperty('_id');

    const collections = await db
      .listCollections({ name: LEGACY_SPANS_COLLECTION })
      .toArray();

    expect(collections).toHaveLength(0);

    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).deleteMany({});
  });

  it('MUST merge the legacy spanContents array into the embedded spans (007)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).deleteMany({});
    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).insertOne({
      traceId: 'legacy-4',
      input: 'oi',
      output: 'olá',
      spans: [
        { spanId: 'span-a', type: 'llm', name: 'gpt', status: 'ok' },
        { spanId: 'span-b', type: 'tool', name: 'consulta', status: 'ok' },
      ],
      spanContents: [
        { spanId: 'span-b', input: { orderId: '88231' }, output: { ok: true } },
      ],
    });

    await mergeSpanContents.run(db);
    await mergeSpanContents.run(db); // idempotent re-run

    const merged = await db
      .collection(LEGACY_TRACE_CONTENTS_COLLECTION)
      .findOne({ traceId: 'legacy-4' });

    expect(merged).not.toHaveProperty('spanContents');
    expect(merged?.spans[0]).toMatchObject({ spanId: 'span-a', input: null, output: null });
    expect(merged?.spans[1]).toMatchObject({
      spanId: 'span-b',
      input: { orderId: '88231' },
      output: { ok: true },
    });

    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).deleteMany({});
  });

  it('MUST merge legacy content documents into traces and drop the collection (008)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(TRACES_COLLECTION).deleteMany({});
    await db.collection(TRACES_COLLECTION).insertOne({
      traceId: 'legacy-5',
      pricingStatus: 'stamped',
      totalCostMicrocents: 777,
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    await db.collection(LEGACY_TRACE_CONTENTS_COLLECTION).insertOne({
      traceId: 'legacy-5',
      input: 'oi',
      output: 'olá',
      spans: [{ spanId: 'span-a', type: 'llm', status: 'ok' }],
    });

    const { mergeContentIntoTraces } = await import(
      '../migrations/008-merge-content-into-traces.js'
    );

    await mergeContentIntoTraces.run(db);
    await mergeContentIntoTraces.run(db); // idempotent re-run

    const merged = await db
      .collection(TRACES_COLLECTION)
      .findOne({ traceId: 'legacy-5' });

    expect(merged?.input).toBe('oi');
    expect(merged?.output).toBe('olá');
    expect(merged?.spans).toHaveLength(1);
    expect(merged?.totalCostMicrocents).toBe(777); // stamp untouched

    const collections = await db
      .listCollections({ name: LEGACY_TRACE_CONTENTS_COLLECTION })
      .toArray();

    expect(collections).toHaveLength(0);

    await db.collection(TRACES_COLLECTION).deleteMany({});
  });

  it('MUST backfill consolidated derived fields on legacy traces (009)', async () => {
    const db = MongoDb.getClient().db();

    await db.collection(TRACES_COLLECTION).deleteMany({});
    await db.collection(TRACES_COLLECTION).insertOne({
      traceId: 'legacy-6',
      pricingStatus: 'stamped',
      totalCostMicrocents: 777,
      startedAt: new Date('2026-06-01T00:00:00.000Z'),
      tokens: { input: 1200, output: 350, cache_read: null, cache_write: 50 },
      spans: [
        {
          spanId: 'span-a',
          startedAt: new Date('2026-06-01T00:00:00.100Z'),
          finishedAt: new Date('2026-06-01T00:00:01.100Z'),
        },
        {
          spanId: 'span-b',
          // Clock skew: span clock ahead of trace clock — offset stays raw.
          startedAt: new Date('2026-05-31T23:59:59.900Z'),
          finishedAt: new Date('2026-06-01T00:00:00.500Z'),
        },
      ],
    });
    await db.collection(TRACES_COLLECTION).insertOne({
      traceId: 'legacy-7',
      pricingStatus: 'pending_price',
      startedAt: new Date('2026-06-02T00:00:00.000Z'),
      tokens: { input: null, output: null, cache_read: null, cache_write: null },
      spans: [],
    });

    const { consolidateDerivedFields } = await import(
      '../migrations/009-consolidate-derived-fields.js'
    );

    await consolidateDerivedFields.run(db);
    await consolidateDerivedFields.run(db); // idempotent re-run

    const backfilled = await db
      .collection(TRACES_COLLECTION)
      .findOne({ traceId: 'legacy-6' });

    expect(backfilled?.tokensTotal).toBe(1200 + 350 + 50);
    expect(backfilled?.spans[0].offsetMs).toBe(100);
    expect(backfilled?.spans[1].offsetMs).toBe(-100);
    expect(backfilled?.totalCostMicrocents).toBe(777); // stamp untouched

    const empty = await db
      .collection(TRACES_COLLECTION)
      .findOne({ traceId: 'legacy-7' });

    expect(empty?.tokensTotal).toBe(0);
    expect(empty?.spans).toEqual([]);

    await db.collection(TRACES_COLLECTION).deleteMany({});
  });
});
