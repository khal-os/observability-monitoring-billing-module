import { Collection, Db, Document } from 'mongodb';
import { Logger } from '../../../../common/logging/logger.js';
import { nullLogger } from '../../../../common/logging/null-logger.js';

export const MIGRATIONS_COLLECTION = 'migrations';

export interface Migration {
  id: string;
  // The logger is the runner's: a migration that has something to say
  // (skipped collision rows, backfill counts) says it through the run's
  // logger, never through console. Optional so tests can drive a single
  // migration directly; the runner always passes one.
  run(db: Db, logger?: Logger): Promise<void>;
}

/**
 * Drops an index if it exists, swallowing ONLY the "it never existed"
 * outcome (fresh deployments run superseding migrations in one chain and
 * never created the older shapes). Any other error — wrong namespace,
 * connection loss, an index the server refuses to drop — rethrows: a
 * silent catch-all here once hid every failure mode behind "already
 * gone" (audit C-7.6).
 */
export const dropIndexIfExists = async (
  collection: Collection<Document>,
  spec: Document,
): Promise<void> => {
  try {
    await collection.dropIndex(spec as never);
  } catch (error) {
    if ((error as { codeName?: string }).codeName !== 'IndexNotFound') {
      throw error;
    }
  }
};

/**
 * Minimal migration runner: applies each migration once, in order, and
 * records it in the `migrations` collection. Takes a connected Db so both
 * the `npm run migrate` job and integration tests can drive it.
 *
 * Concurrency (audit C-7.6): each migration is CLAIMED first via an
 * atomic findOneAndUpdate upsert — a record with `appliedAt` means done
 * (skip), so two `make migrate` runs can never both re-apply a finished
 * migration or crash on a duplicate record insert. A claim WITHOUT
 * `appliedAt` marks a run that crashed mid-migration (or is still in
 * flight): the next runner re-executes it. Migrations must therefore be
 * IDEMPOTENT (createIndex is; seeds use upserts on their natural key) —
 * the runner guarantees at-least-once, never exactly-once.
 */
export const runMigrations = async (
  db: Db,
  migrations: Migration[],
  logger: Logger = nullLogger,
): Promise<string[]> => {
  const collection = db.collection(MIGRATIONS_COLLECTION);

  await collection.createIndex({ id: 1 }, { unique: true });

  const applied: string[] = [];

  for (const migration of migrations) {
    // Atomic claim: inserts {id, claimedAt} iff absent, returns the
    // pre-existing record otherwise. Records written by older runner
    // versions carry appliedAt (done) and are honored unchanged.
    const existing = await collection.findOneAndUpdate(
      { id: migration.id },
      { $setOnInsert: { id: migration.id, claimedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );

    if (existing?.['appliedAt']) {
      continue;
    }

    await migration.run(db, logger);
    await collection.updateOne(
      { id: migration.id },
      { $set: { appliedAt: new Date() } },
    );

    applied.push(migration.id);
  }

  return applied;
};
