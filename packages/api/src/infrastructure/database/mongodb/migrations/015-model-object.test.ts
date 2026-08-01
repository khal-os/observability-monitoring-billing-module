/**
 * Migration 015 proof (audit M5): the ONE data-rewriting migration in the
 * chain (the documented exception to decision 74's indexes-only rule).
 * Exercises the migration module DIRECTLY (`modelObject.run(db)`) so the
 * assertions pin 015's contract and nothing else — 019's later lowercasing
 * backfill is deliberately out of frame (all inputs here are already
 * lowercase): a legacy string `model` becomes the structured
 * `{ id, provider }` ref, NOTHING else on the document moves (the price
 * stamp is immutable — invariant 1), non-string models are untouched, and
 * a second run finds zero documents left to rewrite.
 */
import { Document } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import { modelObject } from './015-model-object.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * A stamped trace exactly as pre-structured deployments stored it: the
 * raw source string in `model`, the immutable stamp alongside it.
 */
const legacyStringModelTrace = (): Document => ({
  _id: 'legacy-string-model',
  traceId: 'trace-migration-legacy-001',
  model: 'openai/gpt-5-mini',
  channel: 'text',
  pricingStatus: 'stamped',
  startedAt: new Date('2026-05-10T12:00:00.000Z'),
  tokensTotal: 1500,
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 1000,
      appliedPriceMicrocentsPerMillion: 27_500_000,
      appliedPriceEffectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
      costMicrocents: 27_500,
    },
    {
      tokenType: 'output',
      tokens: 500,
      appliedPriceMicrocentsPerMillion: 110_000_000,
      appliedPriceEffectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
      costMicrocents: 55_000,
    },
  ],
  totalCostMicrocents: 82_500,
  stampedAt: new Date('2026-05-10T12:05:00.000Z'),
});

/** Already on the structured layout — 015 must not even look at it. */
const structuredModelTrace = (): Document => ({
  _id: 'already-structured',
  traceId: 'trace-migration-structured-001',
  model: { id: 'claude-sonnet-5', provider: 'anthropic' },
  channel: 'text',
  pricingStatus: 'stamped',
  startedAt: new Date('2026-05-11T09:00:00.000Z'),
  tokensTotal: 300,
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 300,
      appliedPriceMicrocentsPerMillion: 165_000_000,
      appliedPriceEffectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
      costMicrocents: 49_500,
    },
  ],
  totalCostMicrocents: 49_500,
  stampedAt: new Date('2026-05-11T09:04:00.000Z'),
});

/** No model at all — pending, and it must stay exactly `null`. */
const nullModelTrace = (): Document => ({
  _id: 'null-model',
  traceId: 'trace-migration-null-001',
  model: null,
  channel: 'text',
  pricingStatus: 'pending_price',
  startedAt: new Date('2026-05-12T18:30:00.000Z'),
  tokensTotal: 700,
  pendingPrice: { reasons: ['unknown_model'] },
});

const omitModel = ({ model, ...rest }: Document): Document => rest;

describe('migration 015-model-object', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  const snapshotById = async (): Promise<Record<string, Document>> =>
    Object.fromEntries(
      (
        await MongoDb.getCollection(TRACES_COLLECTION).find({}).toArray()
      ).map((document) => [String(document._id), document]),
    );

  it('MUST rewrite ONLY legacy string models to the structured ref — stamps byte-identical, twice over', async () => {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    await traces.insertMany([
      legacyStringModelTrace(),
      structuredModelTrace(),
      nullModelTrace(),
    ]);

    const before = await snapshotById();

    await modelObject.run(MongoDb.getClient().db());

    const afterFirstRun = await snapshotById();

    // The legacy string became the SAME structured ref ingestion writes.
    expect(afterFirstRun['legacy-string-model']?.model).toEqual({
      id: 'gpt-5-mini',
      provider: 'openai',
    });

    // ... and NOTHING else on that document moved: the stamp fields
    // (tokens, applied prices, costs, timestamps) are byte-identical —
    // 015 never re-derives a price (invariant 1).
    expect(omitModel(afterFirstRun['legacy-string-model'] as Document)).toStrictEqual(
      omitModel(before['legacy-string-model'] as Document),
    );

    // The already-structured and the null-model documents are untouched
    // in their ENTIRETY (the filter matches string models only).
    expect(afterFirstRun['already-structured']).toStrictEqual(
      before['already-structured'],
    );
    expect(afterFirstRun['null-model']).toStrictEqual(before['null-model']);
    expect(afterFirstRun['null-model']?.model).toBeNull();

    // Idempotency, proven both ways: nothing left matching the rewrite
    // filter, and a second run leaves the collection byte-identical.
    await expect(
      traces.countDocuments({ model: { $type: 'string' } }),
    ).resolves.toBe(0);

    await modelObject.run(MongoDb.getClient().db());

    await expect(snapshotById()).resolves.toStrictEqual(afterFirstRun);
  });
});
