import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../domain/models/billing-snapshot-model.js';

export interface BillingSnapshotRepository {
  /**
   * Persists the snapshot header and its usage records (inputs) — records
   * go one document each into their own collection (a big month must
   * never meet the 16MB document ceiling). Snapshots are immutable once
   * written; (year, month, version) is unique.
   */
  insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void>;

  /** The CURRENT version's snapshot for the month (highest version), or null. */
  findCurrent(year: number, month: number): Promise<BillingSnapshotModel | null>;

  /** A specific version (US5: reopened months show every version). */
  findVersion(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingSnapshotModel | null>;

  /** The stored INPUTS of one snapshot — the reproducibility test's diet. */
  findUsageRecords(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingUsageRecord[]>;
}
