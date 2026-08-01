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
   * audit B-2 (re-audit): THE close write — snapshot inputs + header + the
   * period flip to 'closed' become visible ATOMICALLY. The adapter is free
   * to stage the (unbounded) inputs outside the transaction, as long as
   * the header stays the commit mark: a reader must never observe a
   * snapshot whose inputs are incomplete, and a crash at any point must
   * leave nothing published, so the retry recomputes and closes cleanly.
   *
   * Returns 'conflict' when the period is already closed (the loser of a
   * concurrent double close — nothing published). A duplicate
   * (year, month, version) header surfaces as a typed
   * BillingPeriodStateError, never a raw driver error.
   */
  insertWithPeriodClose(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'>;

  /**
   * re-audit iteration 3: the SAME close write for a month that must never
   * be resident. The month's usage set is one record per stamped trace and
   * unbounded, so the caller does not hand over an array: it is called
   * back with `stage`, pushes the month PAGE BY PAGE (each page released
   * before the next is read) and returns the finished header at the end —
   * so peak memory is one page, not one month. `insertWithPeriodClose` is
   * this same protocol with a single page.
   *
   * `identity` names the staging area BEFORE the header exists (the header
   * is only born once the last page is folded); it MUST match the returned
   * snapshot's (year, month, version).
   *
   * Same guarantees, plus one the array form now also gets: the staged
   * area's lifetime is bounded by the attempt. Every exit that does NOT
   * publish — a conflict, a typed refusal, an error thrown by the caller
   * mid-paging — drops that attempt's rows before returning or rethrowing,
   * so a close that did not happen leaves no trace on disk.
   */
  insertWithPeriodCloseStaged(
    identity: { year: number; month: number; version: number },
    stageAndBuild: (
      stage: (page: BillingUsageRecord[]) => Promise<void>,
    ) => Promise<BillingSnapshotModel>,
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

  /**
   * Just the traceIds a snapshot billed — a projected read of the same
   * durable usage records. The close's repair path (re-audit): when a
   * crash landed the committed close but not the post-close quarantine
   * reconciliation, the retry re-runs the reconciliation from these ids
   * without materializing the full records.
   */
  findUsageTraceIds(
    year: number,
    month: number,
    version: number,
  ): Promise<string[]>;
}
