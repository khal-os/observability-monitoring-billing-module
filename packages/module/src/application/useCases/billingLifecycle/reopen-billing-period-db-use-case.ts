import {
  BillingPeriodRepository,
  BillingPeriodStateError,
  ReopenBillingPeriodResult,
  ReopenBillingPeriodUseCase,
} from './billing-lifecycle-protocols.js';

/**
 * T6: audited reopen — runbook only in v1. Flips the period back to open;
 * every snapshot version stays untouched (the audit trail IS the point).
 * From here the month serves live again, pending stamping unblocks, and
 * the next close writes snapshotVersion + 1.
 */
export class ReopenBillingPeriodDbUseCase implements ReopenBillingPeriodUseCase {
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly now: () => Date;

  constructor(args: {
    billingPeriodRepository: BillingPeriodRepository;
    now?: () => Date;
  }) {
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.now = args.now ?? (() => new Date());
  }

  async reopen(
    year: number,
    month: number,
    reason: string,
  ): Promise<ReopenBillingPeriodResult> {
    if (!reason.trim()) {
      throw new BillingPeriodStateError(
        'Reabertura exige um motivo (REASON) — a ação é auditada (T6).',
      );
    }

    const period = await this.billingPeriodRepository.find(year, month);

    if (period?.status !== 'closed') {
      throw new BillingPeriodStateError(
        `O mês ${year}-${String(month).padStart(2, '0')} não está fechado — nada a reabrir.`,
      );
    }

    const previousSnapshotVersion = period.snapshotVersion ?? 0;

    const outcome = await this.billingPeriodRepository.markReopened({
      year,
      month,
      audit: {
        at: this.now(),
        action: 'reopen',
        trigger: 'runbook',
        reason: reason.trim(),
        snapshotVersion: previousSnapshotVersion,
      },
    });

    if (outcome === 'conflict') {
      throw new BillingPeriodStateError(
        `Reabertura concorrente detectada para ${year}-${month} — nada foi alterado.`,
      );
    }

    return { year, month, previousSnapshotVersion };
  }
}
