import { BillingLifecycleTrigger } from './billing-period-model.js';
import { TokenType } from './price-version-model.js';

/**
 * The month-close snapshot (T6): the ENTIRE audit package that produced a
 * bill, frozen at close time. It stores both sides of the calculation:
 *
 * - INPUTS — one `BillingUsageRecord` per stamped trace of the month
 *   (kept in their own collection, one document each, so a large month
 *   never meets Mongo's document-size ceiling);
 * - OUTPUT — the client-facing `StatementProjection` exactly as the read
 *   layer will serve it forever (T7: a closed month is never recomputed).
 *
 * The reproducibility acceptance test (T6) re-runs the statement engine
 * over the stored inputs and requires EXACT equality with the stored
 * output — to the µ¢ and to the displayed cent.
 */

/**
 * The engine's input for one trace: the ingestion-time stamp, copied —
 * never re-priced (invariant 1; QA19: the close copies stamps, it takes
 * no position on the as-of rule).
 */
export interface BillingUsageRecord {
  traceId: string;
  startedAt: Date;
  agentId: string | null;
  agentVersion: string | null;
  /** Canonical model key string (borders rule, decision 82) — null when unattributed. */
  model: string | null;
  stampedCosts: {
    tokenType: TokenType;
    tokens: number;
    appliedPriceMicrocentsPerMillion: number;
    appliedPriceEffectiveFrom: Date;
    costMicrocents: number;
  }[];
  totalCostMicrocents: number;
}

/**
 * One statement line (US8): agent × version × model × token type × applied
 * unit price → quantity × price = cost. Grouping INCLUDES the applied
 * price (decision 90): a mid-month price change yields separate lines, so
 * every line's `tokens × price = cost` stays literally checkable and the
 * sums stay exact.
 */
/**
 * THE agent grouping key (audit B-3) — injective by construction:
 * JSON.stringify delimits and escapes every element, so no free-form
 * agentId/agentVersion pair can collide ('@@'-joined keys once merged
 * {id:'suporte@@v', version:'2'} with {id:'suporte', version:'v@@2'} —
 * two agents billed as one, invisibly, because the month total was
 * unaffected). Lives in the DOMAIN so the engine (application) and the
 * view-models (presentation) share the one spelling without breaking
 * the layer rules.
 */
export const agentKey = (
  agentId: string | null,
  agentVersion: string | null,
): string => JSON.stringify([agentId, agentVersion]);

export interface StatementLine {
  agentId: string | null;
  agentVersion: string | null;
  model: string | null;
  tokenType: TokenType;
  appliedPriceMicrocentsPerMillion: number;
  appliedPriceEffectiveFrom: Date;
  tokens: number;
  costMicrocents: number;
  /** Largest-remainder reconciled cents — displayed parts sum to the displayed total (T5). */
  displayCents: number;
}

/** Agent × version rollup (decision 48) with its share of the month (US7). */
export interface StatementAgentGroup {
  agentId: string | null;
  agentVersion: string | null;
  tokens: number;
  costMicrocents: number;
  /** Sum of the group's reconciled line cents. */
  displayCents: number;
  /**
   * Share of the month total in basis points (integer, 0-10000),
   * largest-remainder reconciled so the groups sum to exactly 10000.
   */
  percentOfTotalBp: number;
  costByTokenTypeMicrocents: Partial<Record<TokenType, number>>;
}

/** Model share of the month (US15) — cost and tokens, in basis points. */
export interface StatementModelShare {
  model: string | null;
  tokens: number;
  costMicrocents: number;
  costShareBp: number;
  tokenShareBp: number;
}

export interface StatementAgentModelMix {
  agentId: string | null;
  agentVersion: string | null;
  models: StatementModelShare[];
  /**
   * Blended R$/million (US15): group cost ÷ group tokens × 1M, half-up at
   * the µ¢. Derived display metric — never an input to any bill.
   */
  blendedPricePerMillionMicrocents: number | null;
}

/**
 * Cache economics (T9, QA7 answered as "explicit"): the counterfactual
 * prices cache reads AS IF they were normal input, at the same contracted
 * input price stamped on the same trace. Cache write cost is shown
 * explicitly, and netSavings subtracts it. Aggregation is per applied
 * input price bucket (decision 91) — deterministic, derived, never billed.
 */
export interface StatementCacheSavings {
  cacheReadTokens: number;
  actualCacheReadCostMicrocents: number;
  counterfactualInputCostMicrocents: number;
  /** counterfactual − actual cache-read cost. */
  savingsMicrocents: number;
  cacheWriteCostMicrocents: number;
  /** savings − cache write cost (can be negative). */
  netSavingsMicrocents: number;
  /** Traces whose cache reads had no stamped input price to counterfactual against. */
  unpriceableCacheReadTraces: number;
}

/**
 * The full statement of one month — the engine's output, and the ONLY
 * thing the Billing tab ever renders (live for open months, frozen in the
 * snapshot for closed ones). Client-safe by construction: R$ integers and
 * counts only, no USD/PTAX/markup anywhere in the shape (invariant 4).
 */
export interface StatementProjection {
  totalCostMicrocents: number;
  /** Half-up display cents of the total (T5). */
  totalDisplayCents: number;
  stampedTraceCount: number;
  stampedTokensTotal: number;
  lines: StatementLine[];
  agents: StatementAgentGroup[];
  modelMixTotal: StatementModelShare[];
  modelMixByAgent: StatementAgentModelMix[];
  cacheSavings: StatementCacheSavings;
}

export interface BillingSnapshotModel {
  year: number;
  month: number;
  /** 1, 2, ... — bumped by each close after a reopen; all versions kept. */
  version: number;
  createdAt: Date;
  trigger: BillingLifecycleTrigger;
  /** Max ingestedAt among the month's traces at close time (data-freshness watermark). */
  ingestionWatermark: Date | null;
  /** Statement engine version that produced the output. */
  logicVersion: string;
  /**
   * IANA zone whose midnight cut this month's window (decision 130) —
   * recorded so the frozen bill carries its own boundary: a later
   * CLIENT_TIMEZONE change can never silently re-window history, and a
   * re-close of THIS month refuses to run under a different zone.
   */
  timezone: string;
  /** Human-readable rounding rule, recorded for audit (T6). */
  roundingRule: string;
  statement: StatementProjection;
  /**
   * Exceptions ledger (T6): traces excluded from the bill, with reason and
   * decider. v1 is always empty — a close is BLOCKED while any pending-
   * price trace exists in the month, and no other exclusion path exists.
   * The field exists so the snapshot schema is complete from day one.
   */
  exceptions: { traceId: string; reason: string; decidedBy: string }[];
  /** Distinct price versions applied across the month's stamps (audit view). */
  priceVersionsApplied: {
    model: string | null;
    tokenType: TokenType;
    priceMicrocentsPerMillion: number;
    effectiveFrom: Date;
  }[];
  usageRecordCount: number;
}
