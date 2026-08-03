import { Document } from 'mongodb';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../collections.js';
import { PRICE_VERSIONS_COLLECTION } from '../priceVersion/mongodb-price-version-repository.js';
import { priceVersionIndexes } from './001-price-version-indexes.js';
import { lowercaseModelIds } from './019-lowercase-model-ids.js';

const stamp = {
  pricingStatus: 'stamped',
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 100,
      appliedPriceMicrocentsPerMillion: 1_000_000_000,
      appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      costMicrocents: 100_000,
    },
  ],
  totalCostMicrocents: 100_000,
  stampedAt: new Date('2026-06-05T14:01:00.000Z'),
};

const makeTraceDocument = (
  traceId: string,
  model: { id: string; provider: string | null } | null,
): Document => ({
  traceId,
  sessionId: null,
  model,
  type: 'chat',
  channel: { type: 'whatsapp', version: null },
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  durationMs: 4000,
  status: 'ok',
  tokens: { input: 100 },
  tokensTotal: 100,
  ...stamp,
  ingestedAt: new Date('2026-06-05T14:01:00.000Z'),
  input: 'in',
  output: 'out',
  spans: [],
});

const priceRow = (
  model: string,
  tokenType: string,
  effectiveFrom: Date,
  priceMicrocentsPerMillion = 1_000_000_000,
): Document => ({
  model,
  tokenType,
  pricingType: 'fixed_brl',
  priceMicrocentsPerMillion,
  effectiveFrom,
});

const readAll = async (collection: string) =>
  MongoDb.getCollection(collection).find({}, { sort: { _id: 1 } }).toArray();

describe('migration 019-lowercase-model-ids (decision 102, audit B-7)', () => {
  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
    // The collision rule delegates to the unique index — bootstrap it the
    // way the real chain does (001 precedes 019).
    await priceVersionIndexes.run(MongoDb.getClient().db());
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).deleteMany({});
    await MongoDb.getCollection(PRICE_VERSIONS_COLLECTION).deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('MUST lowercase stored trace model ids/providers WITHOUT touching anything else — stamps byte-identical', async () => {
    await MongoDb.getCollection(TRACES_COLLECTION).insertMany([
      makeTraceDocument('trace-upper', {
        id: 'Claude-Sonnet-5',
        provider: 'anthropic',
      }),
      makeTraceDocument('trace-upper-provider', {
        id: 'gpt-5-mini',
        provider: 'OpenAI',
      }),
      makeTraceDocument('trace-lower', {
        id: 'gemini-2.5-pro',
        provider: 'google',
      }),
      makeTraceDocument('trace-no-model', null),
    ]);

    const before = await readAll(TRACES_COLLECTION);

    await lowercaseModelIds.run(MongoDb.getClient().db());

    const after = await readAll(TRACES_COLLECTION);

    // Expectation constructed from the BEFORE image: the ONLY difference
    // allowed is the model casing — every other byte (stamp included,
    // invariants 1/7) must be identical.
    const expected = before.map((document) => ({
      ...document,
      model: document['model']
        ? {
            id: (document['model'] as { id: string }).id.toLowerCase(),
            provider:
              (
                document['model'] as { provider: string | null }
              ).provider?.toLowerCase() ?? null,
          }
        : null,
    }));

    expect(after).toEqual(expected);
    expect(
      after.find((document) => document['traceId'] === 'trace-upper')?.[
        'model'
      ],
    ).toEqual({ id: 'claude-sonnet-5', provider: 'anthropic' });
  });

  it('MUST lowercase price-version keys, letting the unique index adjudicate case-variant duplicates', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const effectiveFrom = new Date('2026-06-01T00:00:00.000Z');
    const prices = MongoDb.getCollection(PRICE_VERSIONS_COLLECTION);

    // Collision: the lowercase row already exists → the variant is skipped.
    await prices.insertOne(priceRow('anthropic/claude-x', 'input', effectiveFrom));
    await prices.insertOne(
      priceRow('Anthropic/Claude-X', 'input', effectiveFrom, 2_000_000_000),
    );
    // Plain rewrite: no lowercase counterpart.
    await prices.insertOne(priceRow('OpenAI/GPT-5', 'input', effectiveFrom));
    // Variants ONLY (no lowercase row): earliest registration wins the
    // canonical key; the later variant collides and is skipped.
    await prices.insertOne(priceRow('Meta/Llama-4', 'output', effectiveFrom));
    await prices.insertOne(priceRow('META/LLAMA-4', 'output', effectiveFrom));

    await lowercaseModelIds.run(MongoDb.getClient().db());

    const after = await readAll(PRICE_VERSIONS_COLLECTION);
    const keys = after.map((document) => [
      document['model'],
      document['priceMicrocentsPerMillion'],
    ]);

    expect(keys).toEqual([
      // Pre-existing lowercase row untouched (still the effective one).
      ['anthropic/claude-x', 1_000_000_000],
      // Its case-variant duplicate left AS STORED (inert) — never deleted,
      // never merged (price versions are immutable, invariant 9).
      ['Anthropic/Claude-X', 2_000_000_000],
      ['openai/gpt-5', 1_000_000_000],
      // Earliest variant took the canonical key...
      ['meta/llama-4', 1_000_000_000],
      // ...the later one skipped.
      ['META/LLAMA-4', 1_000_000_000],
    ]);

    // Every skip is loud.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((call) => call[0]).join('\n')).toContain(
      'Anthropic/Claude-X',
    );
  });

  it('MUST be idempotent: a second run modifies nothing', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const effectiveFrom = new Date('2026-06-01T00:00:00.000Z');

    await MongoDb.getCollection(TRACES_COLLECTION).insertMany([
      makeTraceDocument('trace-upper', {
        id: 'Claude-Sonnet-5',
        provider: 'Anthropic',
      }),
    ]);
    await MongoDb.getCollection(PRICE_VERSIONS_COLLECTION).insertMany([
      priceRow('anthropic/claude-x', 'input', effectiveFrom),
      priceRow('Anthropic/Claude-X', 'input', effectiveFrom, 2_000_000_000),
      priceRow('OpenAI/GPT-5', 'input', effectiveFrom),
    ]);

    const db = MongoDb.getClient().db();

    await lowercaseModelIds.run(db);

    const tracesAfterFirst = await readAll(TRACES_COLLECTION);
    const pricesAfterFirst = await readAll(PRICE_VERSIONS_COLLECTION);

    await lowercaseModelIds.run(db);

    // Byte-identical collections: the crash-replay/second run is a no-op
    // (the deliberately skipped collision row is skipped again).
    expect(await readAll(TRACES_COLLECTION)).toEqual(tracesAfterFirst);
    expect(await readAll(PRICE_VERSIONS_COLLECTION)).toEqual(pricesAfterFirst);

    warn.mockRestore();
  });
});
