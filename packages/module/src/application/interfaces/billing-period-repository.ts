import {
  BillingPeriodAuditEntry,
  BillingPeriodModel,
} from '../../domain/models/billing-period-model.js';

export interface BillingPeriodRepository {
  /** Null when the month never had a lifecycle action (= implicitly open). */
  find(year: number, month: number): Promise<BillingPeriodModel | null>;

  /** Every period that has a document, most recent month first. */
  listAll(): Promise<BillingPeriodModel[]>;

  /**
   * Marks the month closed and appends the audit entry, atomically.
   * Returns 'conflict' when the stored status is already 'closed' —
   * two concurrent close jobs cannot both win.
   */
  markClosed(args: {
    year: number;
    month: number;
    closedAt: Date;
    snapshotVersion: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'closed' | 'conflict'>;

  /**
   * Reopens a closed month (audited, T6). Returns 'conflict' when the
   * month is not currently closed.
   */
  markReopened(args: {
    year: number;
    month: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'reopened' | 'conflict'>;
}
