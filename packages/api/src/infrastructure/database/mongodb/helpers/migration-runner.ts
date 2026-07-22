import { Db } from 'mongodb';

export const MIGRATIONS_COLLECTION = 'migrations';

export interface Migration {
  id: string;
  run(db: Db): Promise<void>;
}

/**
 * Minimal migration runner: applies each migration once, in order, and
 * records it in the `migrations` collection. Takes a connected Db so both
 * the `npm run migrate` job and integration tests can drive it.
 *
 * Applying and recording are two writes, not a transaction: a crash in
 * between makes the next run re-execute that migration. Migrations must
 * therefore be IDEMPOTENT (createIndex is; seeds use upserts on their
 * natural key). Concurrent `migrate` runs are not supported (single
 * operator — PoC).
 */
export const runMigrations = async (
  db: Db,
  migrations: Migration[],
): Promise<string[]> => {
  const collection = db.collection(MIGRATIONS_COLLECTION);

  await collection.createIndex({ id: 1 }, { unique: true });

  const applied: string[] = [];

  for (const migration of migrations) {
    const alreadyApplied = await collection.findOne({ id: migration.id });

    if (alreadyApplied) {
      continue;
    }

    await migration.run(db);
    await collection.insertOne({ id: migration.id, appliedAt: new Date() });

    applied.push(migration.id);
  }

  return applied;
};
