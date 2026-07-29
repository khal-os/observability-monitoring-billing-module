import { TokenType } from '../models/price-version-model.js';
import { ReprocessReport } from './reprocess-pending-use-case.js';

/**
 * T4 write path: registers a NEW price version — always an insert, never
 * an update (invariant 9: versions are immutable; a change is a new
 * effective-from). The model arrives as whatever string the operator has
 * (canonical `provider/id` or a bare id) and is CANONICALIZED to the same
 * key ingestion looks up (decision 82) — a price registered as
 * `gemini-2.5-pro` prices the traces stored as `google/gemini-2.5-pro`.
 *
 * Money is integer µ¢ by the time it reaches the domain — the decimal
 * string → integer conversion happens at the border, never here.
 */
export interface RegisterPriceVersionInput {
  model: string;
  tokenType: TokenType;
  /** Integer micro-centavos (1e-8 R$) per million tokens. Never a float. */
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
  /** Internal-only margin columns (T4) — never client-facing (invariant 4). */
  marketPriceUsd?: number;
  ptaxReference?: number;
  markupPercent?: number;
}

export interface RegisteredPriceVersion {
  /** The CANONICAL model key actually stored (post-normalization). */
  model: string;
  tokenType: TokenType;
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
  /**
   * Decision 57: a new price immediately re-stamps whatever it unblocks —
   * the registration answers with what it stamped, no waiting for the
   * worker's periodic sweep (which stays as backstop).
   */
  reprocess: ReprocessReport;
}

export interface RegisterPriceVersionUseCase {
  register(input: RegisterPriceVersionInput): Promise<RegisteredPriceVersion>;
}
