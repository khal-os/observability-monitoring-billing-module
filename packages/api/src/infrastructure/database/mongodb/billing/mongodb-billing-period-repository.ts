import { Document, UpdateFilter } from 'mongodb';
import {
  BillingPeriodAuditEntry,
  BillingPeriodModel,
} from '../../../../domain/models/billing-period-model.js';
import { BillingPeriodRepository } from '../../../../application/interfaces/billing-period-repository.js';
import { MongoDb } from '../mongo-db.js';

export const BILLING_PERIODS_COLLECTION = 'billing_periods';

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
    const document = await MongoDb.getCollection(BILLING_PERIODS_COLLECTION)
      .findOne<PeriodDocument>({ year, month });

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
    const collection = MongoDb.getCollection(BILLING_PERIODS_COLLECTION);

    // Single guarded upsert: only a non-closed (or absent) period flips —
    // two concurrent close jobs cannot both win (the loser sees conflict).
    try {
      const result = await collection.updateOne(
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
        { upsert: true },
      );

      return result.modifiedCount === 1 || result.upsertedCount === 1
        ? 'closed'
        : 'conflict';
    } catch (error) {
      // Upsert race on the (year, month) unique index: the other writer
      // created the document first — for THIS operation that means the
      // month was (or is being) closed concurrently.
      if ((error as { code?: number }).code === 11000) {
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
    ).updateOne(
      { year: args.year, month: args.month, status: 'closed' },
      {
        $set: { status: 'open', closedAt: null },
        $push: { audit: { ...args.audit } },
      } as unknown as UpdateFilter<Document>,
    );

    return result.modifiedCount === 1 ? 'reopened' : 'conflict';
  }
}
