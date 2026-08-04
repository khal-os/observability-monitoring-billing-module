/**
 * T6: closes a fully-past calendar month (client timezone, decision 130)
 * into an immutable audit snapshot. Two doors, ONE use case: the runbook
 * job (decision 87) and the opt-in auto-close sidecar (decision 131) —
 * the door is recorded as the audit/snapshot `trigger`.
 *
 * Blocked (throws BillingCloseBlockedError) while ANY pending_price trace
 * exists in the month: a bill can never silently exclude open costs.
 */
export interface CloseBillingPeriodResult {
  year: number;
  month: number;
  snapshotVersion: number;
  totalCostMicrocents: number;
  totalDisplayCents: number;
  stampedTraceCount: number;
  ingestionWatermark: Date | null;
  /**
   * Post-close quarantine reconciliation (decision 100): stragglers the
   * snapshot did NOT bill got flagged; previously flagged traces the
   * snapshot DID bill got marked absorbed.
   */
  quarantine: { flaggedStragglers: number; absorbed: number };
}

export interface CloseBillingPeriodUseCase {
  close(year: number, month: number): Promise<CloseBillingPeriodResult>;
}

export class BillingCloseBlockedError extends Error {
  readonly pendingTraceCount: number;
  readonly modelsWithoutPrice: string[];

  constructor(args: {
    pendingTraceCount: number;
    modelsWithoutPrice: string[];
    /**
     * Overrides the default pending-price message — used by blocks that
     * are not about pending prices (e.g. the oldest-first close-order
     * guard). The runbook prints this verbatim, so it must name the fix.
     */
    message?: string;
  }) {
    super(
      args.message ??
        `Fechamento bloqueado: ${args.pendingTraceCount} trace(s) com preço ` +
          `pendente no mês (modelos sem preço: ${
            args.modelsWithoutPrice.join(', ') || '—'
          }). Registre os preços e rode o reprocess antes de fechar.`,
    );
    this.name = 'BillingCloseBlockedError';
    this.pendingTraceCount = args.pendingTraceCount;
    this.modelsWithoutPrice = args.modelsWithoutPrice;
  }
}

export class BillingPeriodStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingPeriodStateError';
  }
}
