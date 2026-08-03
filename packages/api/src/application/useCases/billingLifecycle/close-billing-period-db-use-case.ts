import {
  BillingCloseBlockedError,
  BillingPeriodRepository,
  BillingPeriodStateError,
  BillingQueryRepository,
  BillingSnapshotRepository,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
  TraceRepository,
} from './billing-lifecycle-protocols.js';
import { BillingSnapshotModel } from '../../../domain/models/billing-snapshot-model.js';
import { monthWindowUtc } from '../../../domain/models/billing-period-model.js';
import {
  STATEMENT_LOGIC_VERSION,
  STATEMENT_ROUNDING_RULE,
  buildStatement,
  collectAppliedPriceVersions,
} from '../billingStatement/statement-engine.js';

/**
 * T6: the month close. Freezes the ENTIRE calculation — inputs (usage
 * records, stamps copied verbatim) and output (the statement, produced by
 * the same engine the live path runs) — into an immutable, versioned
 * snapshot, then flips the period to 'closed'.
 *
 * Guards:
 * - only a fully-past UTC calendar month can close (the current month is
 *   partial by definition — invariant 8);
 * - BLOCKED while any pending_price trace exists in the month (T6): the
 *   bill never silently drops open costs;
 * - already-closed month → state error (reopen first, audited).
 */
export class CloseBillingPeriodDbUseCase implements CloseBillingPeriodUseCase {
  private readonly billingQueryRepository: BillingQueryRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly billingSnapshotRepository: BillingSnapshotRepository;
  private readonly traceRepository: Pick<
    TraceRepository,
    'reconcileQuarantineAfterClose'
  >;
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    billingPeriodRepository: BillingPeriodRepository;
    billingSnapshotRepository: BillingSnapshotRepository;
    traceRepository: Pick<TraceRepository, 'reconcileQuarantineAfterClose'>;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingSnapshotRepository = args.billingSnapshotRepository;
    this.traceRepository = args.traceRepository;
    this.now = args.now ?? (() => new Date());
  }

  async close(year: number, month: number): Promise<CloseBillingPeriodResult> {
    const { start, end } = monthWindowUtc(year, month);
    const now = this.now();

    if (end.getTime() > now.getTime()) {
      throw new BillingPeriodStateError(
        `O mês ${year}-${String(month).padStart(2, '0')} ainda não terminou ` +
          '(UTC) — só meses completos podem fechar (invariante 8).',
      );
    }

    const period = await this.billingPeriodRepository.find(year, month);

    if (period?.status === 'closed') {
      throw new BillingPeriodStateError(
        `O mês ${year}-${String(month).padStart(2, '0')} já está fechado ` +
          `(snapshot v${period.snapshotVersion}). Reabra antes de refechar.`,
      );
    }

    const pending = await this.billingQueryRepository.pendingPriceSummary(
      start,
      end,
    );

    if (pending.traceCount > 0) {
      throw new BillingCloseBlockedError({
        pendingTraceCount: pending.traceCount,
        modelsWithoutPrice: pending.models,
      });
    }

    const records = await this.billingQueryRepository.fetchUsageRecords(
      start,
      end,
    );
    const statement = buildStatement(records);
    const ingestionWatermark =
      await this.billingQueryRepository.ingestionWatermark(start, end);

    // audit B-2: collision-proof version — the period doc's counter AND
    // the highest header actually stored (a crash-orphaned header, however
    // it came to exist, must never wedge every retry on the unique index).
    const currentSnapshot = await this.billingSnapshotRepository.findCurrent(
      year,
      month,
    );
    const version =
      Math.max(period?.snapshotVersion ?? 0, currentSnapshot?.version ?? 0) + 1;
    const closedAt = this.now();

    const snapshot: BillingSnapshotModel = {
      year,
      month,
      version,
      createdAt: closedAt,
      trigger: 'runbook',
      ingestionWatermark,
      logicVersion: STATEMENT_LOGIC_VERSION,
      roundingRule: STATEMENT_ROUNDING_RULE,
      statement,
      // v1: always empty — the pending guard above blocks the only
      // exclusion source; the ledger exists for schema completeness (T6).
      exceptions: [],
      priceVersionsApplied: collectAppliedPriceVersions(records),
      usageRecordCount: records.length,
    };

    // audit B-2: snapshot inputs + header + period flip land ATOMICALLY
    // (one transaction inside the adapter, decision 81). A crash leaves
    // NOTHING — the retry recomputes and closes cleanly; a concurrent
    // close loses whole, its half-written records rolled back, never left
    // under the winner's header.
    const outcome = await this.billingSnapshotRepository.insertWithPeriodClose(
      snapshot,
      records,
      {
        closedAt,
        audit: {
          at: closedAt,
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: version,
        },
      },
    );

    if (outcome === 'conflict') {
      throw new BillingPeriodStateError(
        `Fechamento concorrente detectado para ${year}-${month} — nada foi sobrescrito.`,
      );
    }

    // audit B-1 (decision 100): the snapshot adjudicates. With the ids the
    // snapshot billed already in memory, flag every straggler the
    // ingest-vs-close race let through and absorb every flagged trace this
    // version DID bill (reopen→re-close correction, decision 89).
    const quarantine = await this.traceRepository.reconcileQuarantineAfterClose(
      start,
      end,
      records.map((record) => record.traceId),
      version,
    );

    return {
      year,
      month,
      snapshotVersion: version,
      totalCostMicrocents: statement.totalCostMicrocents,
      totalDisplayCents: statement.totalDisplayCents,
      stampedTraceCount: statement.stampedTraceCount,
      ingestionWatermark,
      quarantine,
    };
  }
}
