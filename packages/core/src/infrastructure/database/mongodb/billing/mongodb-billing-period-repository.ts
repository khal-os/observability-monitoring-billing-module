import { ClientSession, Document, UpdateFilter } from 'mongodb';
import {
  BillingPeriodAuditEntry,
  BillingPeriodModel,
} from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodRepository } from '../../../../application/interfaces/billing-period-repository.js';
import { MongoDb } from '../mongo-db.js';
import { isDuplicateKeyError } from '../helpers/is-duplicate-key-error.js';

export const BILLING_PERIODS_COLLECTION = 'billing_periods';

/**
 * The guarded close flip, session-aware — shared between markClosed
 * (standalone) and the snapshot repository's transactional close (audit
 * B-2: the flip must ride the SAME transaction as the snapshot writes).
 * Only a non-closed (or absent) period flips; two concurrent closes
 * cannot both win. Inside a transaction the E11000 upsert race is NOT
 * swallowed here — an errored operation poisons the transaction, so the
 * caller maps it after the abort.
 */
export const applyMarkClosed = async (
  args: {
    year: number;
    month: number;
    closedAt: Date;
    snapshotVersion: number;
    audit: BillingPeriodAuditEntry;
  },
  session?: ClientSession,
): Promise<'closed' | 'conflict'> => {
  const result = await MongoDb.getCollection(
    BILLING_PERIODS_COLLECTION,
  ).updateOne(
    { year: args.year, month: args.month, status: { $ne: 'closed' } },
    {
      $set: {
        status: 'closed',
        closedAt: args.closedAt,
        snapshotVersion: args.snapshotVersion,
      },
      $push: { audit: { ...args.audit } },
      $setOnInsert: { year: args.year, month: args.month },
    } as unknown as UpdateFilter<Document>,
    { upsert: true, session },
  );

  return result.modifiedCount === 1 || result.upsertedCount === 1
    ? 'closed'
    : 'conflict';
};

interface PeriodDocument {
  year: number;
  month: number;
  status: 'open' | 'closed';
  closedAt: Date | null;
  snapshotVersion: number | null;
  audit: BillingPeriodAuditEntry[];
}

const toModel = (document: PeriodDocument): BillingPeriodModel => ({
  year: document.year,
  month: document.month,
  status: document.status,
  closedAt: document.closedAt ?? undefined,
  snapshotVersion: document.snapshotVersion ?? undefined,
  audit: document.audit ?? [],
});

export class MongoDbBillingPeriodRepository implements BillingPeriodRepository {
  async find(year: number, month: number): Promise<BillingPeriodModel | null> {
    const document = await MongoDb.getCollection(
      BILLING_PERIODS_COLLECTION,
    ).findOne<PeriodDocument>({ year, month });

    return document ? toModel(document) : null;
  }

  async listAll(): Promise<BillingPeriodModel[]> {
    const documents = await MongoDb.getCollection(BILLING_PERIODS_COLLECTION)
      .find<PeriodDocument>({})
      .sort({ year: -1, month: -1 })
      .toArray();

    return documents.map(toModel);
  }

  async markClosed(args: {
    year: number;
    month: number;
    closedAt: Date;
    snapshotVersion: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'closed' | 'conflict'> {
    // Single guarded upsert (applyMarkClosed): only a non-closed (or
    // absent) period flips — two concurrent close jobs cannot both win.
    try {
      return await applyMarkClosed(args);
    } catch (error) {
      // Upsert race on the (year, month) unique index: the other writer
      // created the document first — for THIS operation that means the
      // month was (or is being) closed concurrently.
      if (isDuplicateKeyError(error)) {
        return 'conflict';
      }

      throw error;
    }
  }

  async markReopened(args: {
    year: number;
    month: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'reopened' | 'conflict'> {
    const result = await MongoDb.getCollection(
      BILLING_PERIODS_COLLECTION,
    ).updateOne({ year: args.year, month: args.month, status: 'closed' }, {
      $set: { status: 'open', closedAt: null },
      $push: { audit: { ...args.audit } },
    } as unknown as UpdateFilter<Document>);

    return result.modifiedCount === 1 ? 'reopened' : 'conflict';
  }
}
