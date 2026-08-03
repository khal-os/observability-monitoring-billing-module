import {
  BillingPeriodAuditEntry,
  BillingPeriodModel,
} from '../../../domain/models/billing-period-model.js';
import {
  BillingSnapshotModel,
  BillingUsageRecord,
} from '../../../domain/models/billing-snapshot-model.js';
import { BillingPeriodStateError } from '../../../domain/useCases/close-billing-period-use-case.js';
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
  /** Needed only by insertWithPeriodClose — pass the suite's period fake. */
  private readonly periodRepository?: BillingPeriodRepository;

  constructor(periodRepository?: BillingPeriodRepository) {
    this.periodRepository = periodRepository;
  }

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

  /**
   * Honest emulation of the adapter's ONE-transaction close (audit B-2):
   * nothing persists unless the period flip wins — a thrown flip (crash
   * injection) or a lost race leaves the fake byte-identical, exactly like
   * the aborted transaction leaves the store.
   */
  async insertWithPeriodClose(
    snapshot: BillingSnapshotModel,
    usageRecords: BillingUsageRecord[],
    close: { closedAt: Date; audit: BillingPeriodAuditEntry },
  ): Promise<'closed' | 'conflict'> {
    if (!this.periodRepository) {
      throw new Error(
        'InMemoryBillingSnapshotRepository: construct with the period repository to use insertWithPeriodClose',
      );
    }

    const key = this.key(snapshot.year, snapshot.month, snapshot.version);

    if (this.usage.has(key)) {
      // The (year, month, version) unique index, typed (audit B-2).
      throw new BillingPeriodStateError(
        `Snapshot ${key} já existe — fechamento concorrente detectado; nada foi sobrescrito.`,
      );
    }

    const outcome = await this.periodRepository.markClosed({
      year: snapshot.year,
      month: snapshot.month,
      closedAt: close.closedAt,
      snapshotVersion: snapshot.version,
      audit: close.audit,
    });

    if (outcome === 'conflict') return 'conflict';

    await this.insert(snapshot, usageRecords);

    return 'closed';
  }

  async listVersions(
    year: number,
    month: number,
  ): Promise<{ version: number; createdAt: Date }[]> {
    return this.snapshots
      .filter((snapshot) => snapshot.year === year && snapshot.month === month)
      .sort((a, b) => a.version - b.version)
      .map((snapshot) => ({
        version: snapshot.version,
        createdAt: new Date(snapshot.createdAt),
      }));
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

  async listBills(sinceInclusive?: Date | null): Promise<BillRow[]> {
    // Honest bound (audit C-7.1): rows before the open-month bound are
    // closed history — the real scan never sees them.
    if (!sinceInclusive) return this.billRows;

    return this.billRows.filter(
      (row) =>
        Date.UTC(row.year, row.month - 1, 1) >= sinceInclusive.getTime(),
    );
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

/**
 * Recording stub for the close's post-snapshot reconciliation dep (audit
 * B-1, decision 100) — satisfies Pick<TraceRepository,
 * 'reconcileQuarantineAfterClose'>.
 */
export class QuarantineReconcilerStub {
  readonly calls: {
    monthStart: Date;
    monthEnd: Date;
    snapshotTraceIds: string[];
    snapshotVersion: number;
  }[] = [];
  result = { flaggedStragglers: 0, absorbed: 0 };

  async reconcileQuarantineAfterClose(
    monthStart: Date,
    monthEnd: Date,
    snapshotTraceIds: string[],
    snapshotVersion: number,
  ): Promise<{ flaggedStragglers: number; absorbed: number }> {
    this.calls.push({ monthStart, monthEnd, snapshotTraceIds, snapshotVersion });

    return this.result;
  }
}

/** A BillRow with the B-10.4 token pair defaulted consistently. */
export const billRow = (
  overrides: Partial<BillRow> & { year: number; month: number },
): BillRow => ({
  totalCostMicrocents: 0,
  stampedTraceCount: 0,
  pendingTraceCount: 0,
  tokens: 0,
  stampedTokens: 0,
  ...overrides,
});

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
