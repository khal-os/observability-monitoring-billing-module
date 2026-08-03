import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../domain/models/billing-snapshot-model.js';
import { BillingPeriodAuditEntry } from '../../domain/models/billing-period-model.js';

export interface BillingSnapshotRepository {
  /**
   * Persists the snapshot header and its usage records (inputs) — records
   * go one document each into their own collection (a big month must
   * never meet the 16MB document ceiling). Snapshots are immutable once
   * written; (year, month, version) is unique.
   *
   * Storage-only op (tests/tooling). The CLOSE flow MUST use
   * insertWithPeriodClose — this method takes no position on the period.
   */
  insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void>;

  /**
   * audit B-2: THE close write — snapshot inputs + header + the period
   * flip to 'closed' land ATOMICALLY (one transaction in the Mongo
   * adapter, decision 81). A crash can no longer leave an orphan snapshot
   * whose retry wedges on the unique index, and a retry can no longer
   * silently rewrite the stored inputs of an existing version.
   *
   * Returns 'conflict' when the period is already closed (the loser of a
   * concurrent double close — nothing written). A duplicate
   * (year, month, version) header surfaces as a typed
   * BillingPeriodStateError, never a raw driver error.
   */
  insertWithPeriodClose(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'>;

  /** The CURRENT version's snapshot for the month (highest version), or null. */
  findCurrent(year: number, month: number): Promise<BillingSnapshotModel | null>;

  /** A specific version (US5: reopened months show every version). */
  findVersion(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingSnapshotModel | null>;

  /**
   * Every version of the month, ascending — one indexed read (audit
   * C-7.3: replaces the sequential findVersion(1..n) probing).
   */
  listVersions(
    year: number,
    month: number,
  ): Promise<{ version: number; createdAt: Date }[]>;

  /** The stored INPUTS of one snapshot — the reproducibility test's diet. */
  findUsageRecords(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingUsageRecord[]>;
}
