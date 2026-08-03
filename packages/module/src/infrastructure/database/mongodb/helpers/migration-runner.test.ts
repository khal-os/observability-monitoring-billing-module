import { MongoDb } from '../mongo-db.js';
import {
  Migration,
  MIGRATIONS_COLLECTION,
  dropIndexIfExists,
  runMigrations,
} from './migration-runner.js';
import { priceVersionIndexes } from '../migrations/001-price-version-indexes.js';
import { traceIndexes } from '../migrations/003-trace-indexes.js';

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

    await runMigrations(db, [priceVersionIndexes, traceIndexes]);

    // Simulates the crash window: the migration ran but was never recorded,
    // so the next `npm run migrate` re-executes it against a bootstrapped
    // database. Index creation is idempotent by construction (decision 74:
    // the chain carries ONLY deterministic bootstrap).
    await expect(priceVersionIndexes.run(db)).resolves.not.toThrow();
    await expect(traceIndexes.run(db)).resolves.not.toThrow();
  });

  // ── audit C-7.6: atomic claim makes concurrent `make migrate` safe.

  it('concurrent runs MUST NOT crash and MUST leave exactly one record per migration', async () => {
    const log: string[] = [];
    const migrations = [makeMigration('001-a', log), makeMigration('002-b', log)];
    const db = MongoDb.getClient().db();

    await expect(
      Promise.all([
        runMigrations(db, migrations),
        runMigrations(db, migrations),
      ]),
    ).resolves.toBeDefined();

    const records = await MongoDb.getCollection(MIGRATIONS_COLLECTION)
      .find({})
      .toArray();

    expect(records.map((record) => record.id).sort()).toEqual([
      '001-a',
      '002-b',
    ]);
    // At-least-once, never zero: overlapping runners may both execute an
    // in-flight migration (they are idempotent by contract) but a crash
    // on the record write is impossible now.
    expect(log.length).toBeGreaterThanOrEqual(2);

    // A third, sequential apply is a NO-OP.
    const logBefore = log.length;
    const third = await runMigrations(db, migrations);

    expect(third).toEqual([]);
    expect(log.length).toBe(logBefore);
  });

  it('MUST re-execute a migration whose previous runner crashed after claiming (claim without appliedAt)', async () => {
    const log: string[] = [];
    const db = MongoDb.getClient().db();

    // The state a crash between claim and completion leaves behind.
    await MongoDb.getCollection(MIGRATIONS_COLLECTION).insertOne({
      id: '001-a',
      claimedAt: new Date(),
    });

    const applied = await runMigrations(db, [makeMigration('001-a', log)]);

    expect(applied).toEqual(['001-a']);
    expect(log).toEqual(['001-a']);

    const record = await MongoDb.getCollection(MIGRATIONS_COLLECTION).findOne({
      id: '001-a',
    });

    expect(record?.appliedAt).toBeInstanceOf(Date);
  });

  it('MUST honor records written by the pre-claim runner format ({id, appliedAt})', async () => {
    const log: string[] = [];
    const db = MongoDb.getClient().db();

    await MongoDb.getCollection(MIGRATIONS_COLLECTION).insertOne({
      id: '001-a',
      appliedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const applied = await runMigrations(db, [makeMigration('001-a', log)]);

    expect(applied).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe('dropIndexIfExists()', () => {
  const SCRATCH = 'drop_index_scratch';

  beforeAll(async () => {
    await MongoDb.connectWithUri(process.env.MONGO_URL as string);
  });

  afterAll(async () => {
    await MongoDb.disconnect();
  });

  beforeEach(async () => {
    await MongoDb.getCollection(SCRATCH)
      .drop()
      .catch(() => undefined);
  });

  it('MUST drop an existing index and swallow ONLY the not-found case', async () => {
    const collection = MongoDb.getCollection(SCRATCH);
    await collection.createIndex({ startedAt: -1 });

    await expect(
      dropIndexIfExists(collection, { startedAt: -1 }),
    ).resolves.toBeUndefined();
    // Second drop: the index is gone — IndexNotFound is the expected,
    // swallowed outcome.
    await expect(
      dropIndexIfExists(collection, { startedAt: -1 }),
    ).resolves.toBeUndefined();

    const indexes = await collection.indexes();
    expect(indexes.map((index) => index.name)).toEqual(['_id_']);
  });

  it('MUST rethrow anything that is not IndexNotFound', async () => {
    // Dropping an index of a NONEXISTENT collection raises
    // NamespaceNotFound — a different failure that must stay loud.
    const collection = MongoDb.getCollection('never_created_collection');

    await expect(
      dropIndexIfExists(collection, { startedAt: -1 }),
    ).rejects.toThrow();
  });
});
