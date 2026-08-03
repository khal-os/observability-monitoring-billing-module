import { ClientSession } from 'mongodb';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../../domain/models/billing-snapshot-model.js';
import { BillingPeriodAuditEntry } from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodStateError } from '../../../../domain/useCases/close-billing-period-use-case.js';
import { BillingSnapshotRepository } from '../../../../application/interfaces/billing-snapshot-repository.js';
import { MongoDb } from '../mongo-db.js';
import { isDuplicateKeyError } from '../helpers/is-duplicate-key-error.js';
import { applyMarkClosed } from './mongodb-billing-period-repository.js';

export const BILLING_SNAPSHOTS_COLLECTION = 'billing_snapshots';
export const BILLING_SNAPSHOT_USAGE_COLLECTION = 'billing_snapshot_usage';

/** Natural key of a snapshot — also the usage records' parent reference. */
const snapshotKey = (year: number, month: number, version: number): string =>
  `${year}-${String(month).padStart(2, '0')}-v${version}`;

const stripId = <T>(document: T & { _id?: unknown }): T => {
  const { _id, ...rest } = document;

  return rest as T;
};

/** Transaction-internal sentinel: aborts the close txn on a lost race. */
class PeriodFlipConflict extends Error {
  constructor() {
    super('billing period flip lost the close race');
    this.name = 'PeriodFlipConflict';
  }
}

export class MongoDbBillingSnapshotRepository implements BillingSnapshotRepository {
  async insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void> {
    // Storage-only op (tests/tooling) — the close flow uses
    // insertWithPeriodClose. Usage records FIRST, header LAST: readers
    // treat the header as the commit mark.
    await this.writeSnapshot(snapshot, usageRecords);
  }

  /**
   * audit B-2: inputs + header + period flip in ONE transaction (decision
   * 81 infrastructure; compose and jest both run replica sets). Crash →
   * nothing landed, the retry recomputes and closes cleanly. Concurrent
   * close → exactly one winner; the loser's writes are rolled back
   * (never its usage rows under the winner's header) and it surfaces as
   * 'conflict' or a typed BillingPeriodStateError — never a raw E11000.
   */
  async insertWithPeriodClose(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'> {
    try {
      await MongoDb.withTransaction(async (session) => {
        await this.writeSnapshot(snapshot, usageRecords, session);

        let outcome: 'closed' | 'conflict';
        try {
          outcome = await this.flipPeriodClosed(session, {
            year: snapshot.year,
            month: snapshot.month,
            closedAt: close.closedAt,
            snapshotVersion: snapshot.version,
            audit: close.audit,
          });
        } catch (error) {
          // The guarded upsert's E11000 on (year, month) — the period doc
          // already exists as 'closed', or a concurrent close created it
          // first. Same meaning markClosed maps standalone: conflict. The
          // op error already aborted the transaction server-side; the
          // sentinel makes the driver finish the abort cleanly.
          if (isDuplicateKeyError(error)) {
            throw new PeriodFlipConflict();
          }

          throw error;
        }

        if (outcome === 'conflict') {
          // Abort — the snapshot writes above must not survive a lost
          // race (they would sit under a period that never flipped, or
          // worse, replace a live version's inputs).
          throw new PeriodFlipConflict();
        }
      });
    } catch (error) {
      if (error instanceof PeriodFlipConflict) {
        return 'conflict';
      }

      // The (year, month, version) unique header index — or the period
      // upsert race — fired inside the transaction: a concurrent close
      // won. Typed, so the runbook prints a clean 409-class message.
      if (isDuplicateKeyError(error)) {
        throw new BillingPeriodStateError(
          `Snapshot ${snapshotKey(snapshot.year, snapshot.month, snapshot.version)} ` +
            'já existe — fechamento concorrente detectado; nada foi sobrescrito.',
        );
      }

      throw error;
    }

    return 'closed';
  }

  /** Overridable seam for the crash-between-writes-and-flip test (M8). */
  protected async flipPeriodClosed(
    session: ClientSession,
    args: {
      year: number;
      month: number;
      closedAt: Date;
      snapshotVersion: number;
      audit: BillingPeriodAuditEntry;
    },
  ): Promise<'closed' | 'conflict'> {
    return applyMarkClosed(args, session);
  }

  private async writeSnapshot(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    session?: ClientSession,
  ): Promise<void> {
    const snapshots = MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION);
    const usage = MongoDb.getCollection(BILLING_SNAPSHOT_USAGE_COLLECTION);
    const key = snapshotKey(snapshot.year, snapshot.month, snapshot.version);

    // The deleteMany clears orphan usage rows a pre-transaction version of
    // this repository could have left; inside the close transaction it is
    // all-or-nothing with the writes below.
    await usage.deleteMany({ snapshotKey: key }, { session });

    if (usageRecords.length > 0) {
      await usage.insertMany(
        usageRecords.map((record) => ({ snapshotKey: key, ...record })),
        { ordered: true, session },
      );
    }

    // The (year, month, version) unique index makes snapshots immutable:
    // re-inserting an existing version is an error, never an overwrite.
    await snapshots.insertOne({ ...snapshot }, { session });
  }

  async findCurrent(
    year: number,
    month: number,
  ): Promise<BillingSnapshotModel | null> {
    const document = await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION)
      .find({ year, month })
      .sort({ version: -1 })
      .limit(1)
      .next();

    return document ? (stripId(document) as unknown as BillingSnapshotModel) : null;
  }

  async findVersion(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingSnapshotModel | null> {
    const document = await MongoDb.getCollection(
      BILLING_SNAPSHOTS_COLLECTION,
    ).findOne({ year, month, version });

    return document ? (stripId(document) as unknown as BillingSnapshotModel) : null;
  }

  async listVersions(
    year: number,
    month: number,
  ): Promise<{ version: number; createdAt: Date }[]> {
    // audit C-7.3: one indexed find over (year, month, version) — replaces
    // the sequential findVersion(1..n) probing.
    const documents = await MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION)
      .find(
        { year, month },
        { projection: { _id: 0, version: 1, createdAt: 1 } },
      )
      .sort({ version: 1 })
      .toArray();

    return documents.map((document) => ({
      version: document['version'] as number,
      createdAt: document['createdAt'] as Date,
    }));
  }

  async findUsageTraceIds(
    year: number,
    month: number,
    version: number,
  ): Promise<string[]> {
    // Projected read of the durable inputs — the close's reconcile-repair
    // diet (re-audit): ids only, never the full records.
    const documents = await MongoDb.getCollection(
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    )
      .find(
        { snapshotKey: snapshotKey(year, month, version) },
        { projection: { _id: 0, traceId: 1 } },
      )
      .toArray();

    return documents.map((document) => document['traceId'] as string);
  }

  async findUsageRecords(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingUsageRecord[]> {
    const documents = await MongoDb.getCollection(
      BILLING_SNAPSHOT_USAGE_COLLECTION,
    )
      .find({ snapshotKey: snapshotKey(year, month, version) })
      .sort({ traceId: 1 })
      .toArray();

    return documents.map((document) => {
      const { _id, snapshotKey: _key, ...record } = document;

      return record as unknown as BillingUsageRecord;
    });
  }
}
