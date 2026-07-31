/**
 * T6: closes a fully-past UTC calendar month into an immutable audit
 * snapshot. Runbook-triggered only in v1 (QA4 answered — decision 87).
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
}

export interface CloseBillingPeriodUseCase {
  close(year: number, month: number): Promise<CloseBillingPeriodResult>;
}

export class BillingCloseBlockedError extends Error {
  readonly pendingTraceCount: number;
  readonly modelsWithoutPrice: string[];

  constructor(args: { pendingTraceCount: number; modelsWithoutPrice: string[] }) {
    super(
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
