import { MongoDb } from '../mongo-db.js';
import {
  Migration,
  MIGRATIONS_COLLECTION,
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
});
