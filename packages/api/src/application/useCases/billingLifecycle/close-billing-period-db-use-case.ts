import {
  BillingCloseBlockedError,
  BillingPeriodRepository,
  BillingPeriodStateError,
  BillingQueryRepository,
  BillingSnapshotRepository,
  CloseBillingPeriodResult,
  CloseBillingPeriodUseCase,
} from './billing-lifecycle-protocols.js';
import { BillingSnapshotModel } from '../../../domain/models/billing-snapshot-model.js';
import { monthWindowUtc } from '../billingSummary/get-billing-summary-db-use-case.js';
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
  private readonly now: () => Date;

  constructor(args: {
    billingQueryRepository: BillingQueryRepository;
    billingPeriodRepository: BillingPeriodRepository;
    billingSnapshotRepository: BillingSnapshotRepository;
    now?: () => Date;
  }) {
    this.billingQueryRepository = args.billingQueryRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.billingSnapshotRepository = args.billingSnapshotRepository;
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

    const version = (period?.snapshotVersion ?? 0) + 1;
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

    // Snapshot first, period flip second: a crash in between leaves an
    // orphan snapshot version and an OPEN period — harmless (the next
    // close writes version + 1), while the reverse order would leave a
    // closed period with no snapshot (corrupt state the readers refuse).
    await this.billingSnapshotRepository.insert(snapshot, records);

    const outcome = await this.billingPeriodRepository.markClosed({
      year,
      month,
      closedAt,
      snapshotVersion: version,
      audit: {
        at: closedAt,
        action: 'close',
        trigger: 'runbook',
        snapshotVersion: version,
      },
    });

    if (outcome === 'conflict') {
      throw new BillingPeriodStateError(
        `Fechamento concorrente detectado para ${year}-${month} — nada foi sobrescrito.`,
      );
    }

    return {
      year,
      month,
      snapshotVersion: version,
      totalCostMicrocents: statement.totalCostMicrocents,
      totalDisplayCents: statement.totalDisplayCents,
      stampedTraceCount: statement.stampedTraceCount,
      ingestionWatermark,
    };
  }
}
