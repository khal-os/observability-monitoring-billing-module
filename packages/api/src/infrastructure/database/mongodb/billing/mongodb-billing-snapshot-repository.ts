import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../../domain/models/billing-snapshot-model.js';
import { BillingSnapshotRepository } from '../../../../application/interfaces/billing-snapshot-repository.js';
import { MongoDb } from '../mongo-db.js';

export const BILLING_SNAPSHOTS_COLLECTION = 'billing_snapshots';
export const BILLING_SNAPSHOT_USAGE_COLLECTION = 'billing_snapshot_usage';

/** Natural key of a snapshot — also the usage records' parent reference. */
const snapshotKey = (year: number, month: number, version: number): string =>
  `${year}-${String(month).padStart(2, '0')}-v${version}`;

const stripId = <T>(document: T & { _id?: unknown }): T => {
  const { _id, ...rest } = document;

  return rest as T;
};

export class MongoDbBillingSnapshotRepository implements BillingSnapshotRepository {
  async insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void> {
    const snapshots = MongoDb.getCollection(BILLING_SNAPSHOTS_COLLECTION);
    const usage = MongoDb.getCollection(BILLING_SNAPSHOT_USAGE_COLLECTION);
    const key = snapshotKey(snapshot.year, snapshot.month, snapshot.version);

    // Usage records FIRST, header LAST: readers treat the header as the
    // commit mark — a crash mid-write leaves orphan usage rows keyed to a
    // version that never got a header, invisible to every read path and
    // harmlessly overwritten by the retry (deleteMany below).
    await usage.deleteMany({ snapshotKey: key });

    if (usageRecords.length > 0) {
      await usage.insertMany(
        usageRecords.map((record) => ({ snapshotKey: key, ...record })),
        { ordered: true },
      );
    }

    // The (year, month, version) unique index makes snapshots immutable:
    // re-inserting an existing version is an error, never an overwrite.
    await snapshots.insertOne({ ...snapshot });
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
