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
 * - CLOSE ORDER (re-audit): months close OLDEST-FIRST — closing M while an
 *   older month still has traces and was never closed is blocked, naming
 *   the month to close first. The C-7.1 live-scan bound
 *   (firstOpenMonthStart) starts at the earliest non-closed month, so an
 *   out-of-order close would silently drop the skipped month's money from
 *   /bills and the monthly series while the summary still showed it;
 * - BLOCKED while any pending_price trace exists in the month (T6): the
 *   bill never silently drops open costs;
 * - already-closed month → state error (reopen first, audited) — after
 *   RE-RUNNING the post-close quarantine reconciliation from the durable
 *   snapshot, so a retry of a close that crashed between the committed
 *   transaction and the reconciliation heals instead of just refusing.
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
      await this.repairReconciliationAndRefuse(year, month, start, end, period);
    }

    // Re-audit close-order guard: every month from the earliest stored
    // trace up to M-1 must be closed or trace-free BEFORE M closes.
    await this.assertOlderMonthsClosed(year, month);

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

  /**
   * Re-audit repair path: the reconciliation runs AFTER the committed
   * close transaction, so a crash (or throw) between the two leaves the
   * month closed-but-unreconciled — and the natural retry
   * (`make billing-close` again) used to refuse with "já está fechado"
   * WITHOUT healing. Before refusing, re-run the reconciliation (both
   * passes are idempotent) from the DURABLE snapshot usage ids of the
   * CURRENT version; the refusal message then says so. Exit semantics are
   * unchanged: the runbook still surfaces the already-closed state error.
   */
  private async repairReconciliationAndRefuse(
    year: number,
    month: number,
    start: Date,
    end: Date,
    period: { snapshotVersion?: number },
  ): Promise<never> {
    const alreadyClosed =
      `O mês ${year}-${String(month).padStart(2, '0')} já está fechado ` +
      `(snapshot v${period.snapshotVersion}). Reabra antes de refechar.`;

    if (typeof period.snapshotVersion !== 'number') {
      // Corrupt lifecycle document — nothing durable to reconcile from;
      // refuse plainly (the summary path reports the corruption loudly).
      throw new BillingPeriodStateError(alreadyClosed);
    }

    const billedTraceIds = await this.billingSnapshotRepository.findUsageTraceIds(
      year,
      month,
      period.snapshotVersion,
    );

    await this.traceRepository.reconcileQuarantineAfterClose(
      start,
      end,
      billedTraceIds,
      period.snapshotVersion,
    );

    throw new BillingPeriodStateError(
      `${alreadyClosed} Reconciliação de quarentena reverificada/reparada ` +
        `a partir do snapshot v${period.snapshotVersion}.`,
    );
  }

  /**
   * Re-audit close-order guard: firstOpenMonthStart (the C-7.1 live-scan
   * bound) walks forward from the EARLIEST closed month — so closing M
   * while an OLDER month still has traces and was never closed would push
   * that month behind the bound: its money would vanish from /bills and
   * the monthly series while the summary still showed it. Enforce
   * oldest-first here: every month from the earliest stored trace to M-1
   * must be closed or trace-free (a genuine no-traffic gap month passes).
   */
  private async assertOlderMonthsClosed(
    year: number,
    month: number,
  ): Promise<void> {
    const earliest = await this.billingQueryRepository.earliestTraceAt();

    if (!earliest) return;

    const targetOrdinal = year * 12 + (month - 1);
    let cursorYear = earliest.getUTCFullYear();
    let cursorMonth = earliest.getUTCMonth() + 1;

    if (cursorYear * 12 + (cursorMonth - 1) >= targetOrdinal) return;

    const closedMonths = new Set(
      (await this.billingPeriodRepository.listAll())
        .filter((period) => period.status === 'closed')
        .map((period) => `${period.year}-${period.month}`),
    );

    // Months are few (one iteration per calendar month of history), and
    // the trace-free probe only runs for the non-closed ones.
    while (cursorYear * 12 + (cursorMonth - 1) < targetOrdinal) {
      if (!closedMonths.has(`${cursorYear}-${cursorMonth}`)) {
        const window = monthWindowUtc(cursorYear, cursorMonth);

        if (await this.billingQueryRepository.hasTraces(window.start, window.end)) {
          const blocking = `${cursorYear}-${String(cursorMonth).padStart(2, '0')}`;

          throw new BillingCloseBlockedError({
            pendingTraceCount: 0,
            modelsWithoutPrice: [],
            message:
              `Fechamento de ${year}-${String(month).padStart(2, '0')} ` +
              `bloqueado: o mês ${blocking} tem traces e nunca foi fechado — ` +
              `feche ${blocking} primeiro (fechamento é sempre do mês mais ` +
              'antigo para o mais novo).',
          });
        }
      }

      cursorMonth += 1;

      if (cursorMonth === 13) {
        cursorMonth = 1;
        cursorYear += 1;
      }
    }
  }
}
