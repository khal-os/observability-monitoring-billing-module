import {
  BillingPeriodAuditEntry,
  BillingPeriodModel,
} from '../../../domain/models/billing-period-model.js';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../domain/models/billing-snapshot-model.js';
import {
  PendingPriceSummary,
} from '../../../domain/useCases/get-billing-summary-use-case.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';
import { BillingSnapshotRepository } from '../../interfaces/billing-snapshot-repository.js';
import {
  BillRow,
  BillingQueryRepository,
  DailyRollupRow,
  MonthlyRollupRow,
} from '../../interfaces/billing-query-repository.js';

/**
 * In-memory fakes shared by the billing specs — same contracts as the
 * Mongo repositories, honest state machines (conflicts included) so the
 * lifecycle specs exercise the real protocol, not a yes-machine.
 */

export class InMemoryBillingPeriodRepository implements BillingPeriodRepository {
  readonly periods = new Map<string, BillingPeriodModel>();

  private key(year: number, month: number): string {
    return `${year}-${month}`;
  }

  async find(year: number, month: number): Promise<BillingPeriodModel | null> {
    return this.periods.get(this.key(year, month)) ?? null;
  }

  async listAll(): Promise<BillingPeriodModel[]> {
    return [...this.periods.values()].sort(
      (a, b) => b.year - a.year || b.month - a.month,
    );
  }

  async markClosed(args: {
    year: number;
    month: number;
    closedAt: Date;
    snapshotVersion: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'closed' | 'conflict'> {
    const existing = await this.find(args.year, args.month);

    if (existing?.status === 'closed') return 'conflict';

    this.periods.set(this.key(args.year, args.month), {
      year: args.year,
      month: args.month,
      status: 'closed',
      closedAt: args.closedAt,
      snapshotVersion: args.snapshotVersion,
      audit: [...(existing?.audit ?? []), args.audit],
    });

    return 'closed';
  }

  async markReopened(args: {
    year: number;
    month: number;
    audit: BillingPeriodAuditEntry;
  }): Promise<'reopened' | 'conflict'> {
    const existing = await this.find(args.year, args.month);

    if (existing?.status !== 'closed') return 'conflict';

    this.periods.set(this.key(args.year, args.month), {
      ...existing,
      status: 'open',
      closedAt: undefined,
      audit: [...existing.audit, args.audit],
    });

    return 'reopened';
  }
}

export class InMemoryBillingSnapshotRepository implements BillingSnapshotRepository {
  readonly snapshots: BillingSnapshotModel[] = [];
  readonly usage = new Map<string, BillingUsageRecord[]>();

  private key(year: number, month: number, version: number): string {
    return `${year}-${month}-v${version}`;
  }

  async insert(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
  ): Promise<void> {
    const key = this.key(snapshot.year, snapshot.month, snapshot.version);

    if (this.usage.has(key)) {
      throw new Error(`duplicate snapshot ${key}`);
    }

    // Deep copy: snapshots are immutable — a caller mutating its objects
    // afterwards must not reach into the "stored" state.
    this.snapshots.push(JSON.parse(JSON.stringify(snapshot)));
    this.usage.set(key, JSON.parse(JSON.stringify(usageRecords)));
  }

  private revive(snapshot: BillingSnapshotModel): BillingSnapshotModel {
    return JSON.parse(JSON.stringify(snapshot));
  }

  async findCurrent(
    year: number,
    month: number,
  ): Promise<BillingSnapshotModel | null> {
    const versions = this.snapshots
      .filter((snapshot) => snapshot.year === year && snapshot.month === month)
      .sort((a, b) => b.version - a.version);

    return versions[0] ? this.revive(versions[0]) : null;
  }

  async findVersion(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingSnapshotModel | null> {
    const found = this.snapshots.find(
      (snapshot) =>
        snapshot.year === year &&
        snapshot.month === month &&
        snapshot.version === version,
    );

    return found ? this.revive(found) : null;
  }

  async findUsageRecords(
    year: number,
    month: number,
    version: number,
  ): Promise<BillingUsageRecord[]> {
    const records = this.usage.get(this.key(year, month, version)) ?? [];

    // Dates survive the JSON round-trip as strings in the fake — revive
    // them the way the BSON layer would.
    return JSON.parse(JSON.stringify(records), (key, value) =>
      ['startedAt', 'appliedPriceEffectiveFrom'].includes(key)
        ? new Date(value)
        : value,
    );
  }
}

const EMPTY_PENDING: PendingPriceSummary = {
  traceCount: 0,
  tokens: {},
  models: [],
};

/** Configurable per-month data source for the query side. */
export class StubBillingQueryRepository implements BillingQueryRepository {
  usageByMonth = new Map<string, BillingUsageRecord[]>();
  pendingByMonth = new Map<string, PendingPriceSummary>();
  watermarkByMonth = new Map<string, Date>();
  quarantinedByMonth = new Map<string, number>();
  billRows: BillRow[] = [];
  rollupRows: MonthlyRollupRow[] = [];
  dailyRows: DailyRollupRow[] = [];
  accrued = 0;

  private monthKey(monthStart: Date): string {
    return `${monthStart.getUTCFullYear()}-${monthStart.getUTCMonth() + 1}`;
  }

  async pendingPriceSummary(monthStart: Date): Promise<PendingPriceSummary> {
    return this.pendingByMonth.get(this.monthKey(monthStart)) ?? EMPTY_PENDING;
  }

  async listBills(): Promise<BillRow[]> {
    return this.billRows;
  }

  async fetchUsageRecords(monthStart: Date): Promise<BillingUsageRecord[]> {
    return this.usageByMonth.get(this.monthKey(monthStart)) ?? [];
  }

  async monthlyRollup(): Promise<MonthlyRollupRow[]> {
    return this.rollupRows;
  }

  async dailyRollup(from: Date, toExclusive: Date): Promise<DailyRollupRow[]> {
    return this.dailyRows.filter(
      (row) => row.date >= from && row.date < toExclusive,
    );
  }

  async ingestionWatermark(monthStart: Date): Promise<Date | null> {
    return this.watermarkByMonth.get(this.monthKey(monthStart)) ?? null;
  }

  async countQuarantined(monthStart: Date): Promise<number> {
    return this.quarantinedByMonth.get(this.monthKey(monthStart)) ?? 0;
  }

  async accruedCostMicrocents(): Promise<number> {
    return this.accrued;
  }
}

export const usageRecord = (
  overrides: Partial<BillingUsageRecord> & { traceId: string },
): BillingUsageRecord => ({
  startedAt: new Date('2026-06-10T12:00:00.000Z'),
  agentId: 'eugenia',
  agentVersion: '1.0.0',
  model: 'anthropic/claude-sonnet-4-6',
  stampedCosts: [
    {
      tokenType: 'input',
      tokens: 1_000_000,
      appliedPriceMicrocentsPerMillion: 2_500_000_000,
      appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      costMicrocents: 2_500_000_000,
    },
  ],
  totalCostMicrocents: 2_500_000_000,
  ...overrides,
});
