import {
  buildStatement,
  collectAppliedPriceVersions,
} from './statement-engine.js';
import { BillingUsageRecord } from '../../../domain/models/billing-snapshot-model.js';
import { costMicrocents } from '../../../common/helpers/money/money.js';

const PRICE_INPUT = 2_500_000_000; // R$ 25,00 / M
const PRICE_INPUT_V2 = 3_000_000_000; // mid-month change: R$ 30,00 / M
const PRICE_OUTPUT = 12_500_000_000; // R$ 125,00 / M
const PRICE_CACHE_READ = 250_000_000; // R$ 2,50 / M (10% of input)
const PRICE_CACHE_WRITE = 3_125_000_000;

const V1_FROM = new Date('2026-06-01T00:00:00Z');
const V2_FROM = new Date('2026-06-15T00:00:00Z');

const stamped = (
  tokenType: BillingUsageRecord['stampedCosts'][number]['tokenType'],
  tokens: number,
  price: number,
  effectiveFrom = V1_FROM,
) => ({
  tokenType,
  tokens,
  appliedPriceMicrocentsPerMillion: price,
  appliedPriceEffectiveFrom: effectiveFrom,
  costMicrocents: costMicrocents(tokens, price),
});

const record = (
  traceId: string,
  agentId: string | null,
  model: string | null,
  costs: BillingUsageRecord['stampedCosts'],
): BillingUsageRecord => ({
  traceId,
  startedAt: new Date('2026-06-10T12:00:00Z'),
  agentId,
  agentVersion: agentId ? '1.0.0' : null,
  model,
  stampedCosts: costs,
  totalCostMicrocents: costs.reduce((sum, cost) => sum + cost.costMicrocents, 0),
});

const FIXTURE: BillingUsageRecord[] = [
  record('t1', 'eugenia', 'anthropic/claude-sonnet-4-6', [
    stamped('input', 1_000_000, PRICE_INPUT),
    stamped('output', 200_000, PRICE_OUTPUT),
    stamped('cache_read', 400_000, PRICE_CACHE_READ),
    stamped('cache_write', 50_000, PRICE_CACHE_WRITE),
  ]),
  record('t2', 'eugenia', 'anthropic/claude-sonnet-4-6', [
    // Same month, price v2 — MUST NOT merge with t1's input line (US8:
    // every line stays quantity × one price = cost).
    stamped('input', 500_000, PRICE_INPUT_V2, V2_FROM),
    stamped('output', 100_000, PRICE_OUTPUT),
  ]),
  record('t3', 'suporte', 'anthropic/claude-haiku-4-5', [
    stamped('input', 3_000_000, PRICE_INPUT),
    stamped('output', 50_000, PRICE_OUTPUT),
  ]),
  record('t4', null, null, [stamped('input', 10_000, PRICE_INPUT)]),
];

describe('buildStatement (the single billing calculation — invariant 3)', () => {
  it('total ≡ sum of stamped line costs, and lines carry quantity × applied price = cost', () => {
    const statement = buildStatement(FIXTURE);

    const lineSum = statement.lines.reduce(
      (sum, line) => sum + line.costMicrocents,
      0,
    );
    expect(statement.totalCostMicrocents).toBe(lineSum);

    for (const line of statement.lines) {
      // US8: every line is literally re-checkable by the manager.
      expect(line.costMicrocents).toBe(
        costMicrocents(line.tokens, line.appliedPriceMicrocentsPerMillion),
      );
    }
  });

  it('a mid-month price change yields SEPARATE lines for the same dimension tuple', () => {
    const statement = buildStatement(FIXTURE);

    const eugeniaInputLines = statement.lines.filter(
      (line) => line.agentId === 'eugenia' && line.tokenType === 'input',
    );

    expect(eugeniaInputLines).toHaveLength(2);
    expect(
      eugeniaInputLines.map((line) => line.appliedPriceMicrocentsPerMillion).sort(),
    ).toEqual([PRICE_INPUT, PRICE_INPUT_V2].sort());
  });

  it('displayed parts close exactly: line cents sum to the total cents, agent groups too (T5)', () => {
    const statement = buildStatement(FIXTURE);

    const lineCents = statement.lines.reduce(
      (sum, line) => sum + line.displayCents,
      0,
    );
    expect(lineCents).toBe(statement.totalDisplayCents);

    const groupCents = statement.agents.reduce(
      (sum, group) => sum + group.displayCents,
      0,
    );
    expect(groupCents).toBe(statement.totalDisplayCents);
  });

  it('agent shares are integer basis points summing exactly to 10000 (US7)', () => {
    const statement = buildStatement(FIXTURE);

    const totalBp = statement.agents.reduce(
      (sum, group) => sum + group.percentOfTotalBp,
      0,
    );
    expect(totalBp).toBe(10_000);
    expect(
      statement.agents.every((group) => Number.isInteger(group.percentOfTotalBp)),
    ).toBe(true);
  });

  it('model mix closes at 100% for cost and tokens, total and per agent (T9/US15)', () => {
    const statement = buildStatement(FIXTURE);

    const costBp = statement.modelMixTotal.reduce((s, m) => s + m.costShareBp, 0);
    const tokenBp = statement.modelMixTotal.reduce((s, m) => s + m.tokenShareBp, 0);
    expect(costBp).toBe(10_000);
    expect(tokenBp).toBe(10_000);

    for (const agentMix of statement.modelMixByAgent) {
      expect(agentMix.models.reduce((s, m) => s + m.costShareBp, 0)).toBe(10_000);
    }

    // Mix cost is derived from the same lines — reconciles with the total.
    const mixCost = statement.modelMixTotal.reduce(
      (sum, share) => sum + share.costMicrocents,
      0,
    );
    expect(mixCost).toBe(statement.totalCostMicrocents);
  });

  it('cache savings: counterfactual prices cache reads at the SAME trace input price; write cost explicit (QA7)', () => {
    const statement = buildStatement(FIXTURE);
    const cache = statement.cacheSavings;

    expect(cache.cacheReadTokens).toBe(400_000);
    expect(cache.actualCacheReadCostMicrocents).toBe(
      costMicrocents(400_000, PRICE_CACHE_READ),
    );
    expect(cache.counterfactualInputCostMicrocents).toBe(
      costMicrocents(400_000, PRICE_INPUT),
    );
    expect(cache.savingsMicrocents).toBe(
      cache.counterfactualInputCostMicrocents - cache.actualCacheReadCostMicrocents,
    );
    expect(cache.cacheWriteCostMicrocents).toBe(
      costMicrocents(50_000, PRICE_CACHE_WRITE),
    );
    expect(cache.netSavingsMicrocents).toBe(
      cache.savingsMicrocents - cache.cacheWriteCostMicrocents,
    );
    expect(cache.unpriceableCacheReadTraces).toBe(0);
  });

  it('a cache read with no stamped input price is counted, not silently priced (honesty)', () => {
    const statement = buildStatement([
      record('t9', 'a', 'm', [stamped('cache_read', 1_000, PRICE_CACHE_READ)]),
    ]);

    expect(statement.cacheSavings.unpriceableCacheReadTraces).toBe(1);
    expect(statement.cacheSavings.counterfactualInputCostMicrocents).toBe(0);
  });

  it('unattributed traces (null agent/model) appear honestly as their own group', () => {
    const statement = buildStatement(FIXTURE);

    const nullGroup = statement.agents.find((group) => group.agentId === null);
    expect(nullGroup).toBeDefined();
    expect(nullGroup?.costMicrocents).toBe(costMicrocents(10_000, PRICE_INPUT));
  });

  it('is DETERMINISTIC: same records in any order produce the identical statement (reproducibility, T6)', () => {
    const forward = buildStatement(FIXTURE);
    const reversed = buildStatement([...FIXTURE].reverse());

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  it('empty month: zero totals, empty collections, no division blow-ups', () => {
    const statement = buildStatement([]);

    expect(statement.totalCostMicrocents).toBe(0);
    expect(statement.totalDisplayCents).toBe(0);
    expect(statement.lines).toHaveLength(0);
    expect(statement.agents).toHaveLength(0);
    expect(statement.modelMixTotal).toHaveLength(0);
    expect(statement.cacheSavings.savingsMicrocents).toBe(0);
  });
});

describe('collectAppliedPriceVersions', () => {
  it('lists each distinct (model, type, price, effectiveFrom) once, deterministically ordered', () => {
    const versions = collectAppliedPriceVersions(FIXTURE);

    const inputVersions = versions.filter(
      (version) =>
        version.model === 'anthropic/claude-sonnet-4-6' &&
        version.tokenType === 'input',
    );
    expect(inputVersions).toHaveLength(2);

    const again = collectAppliedPriceVersions([...FIXTURE].reverse());
    expect(JSON.stringify(again)).toBe(JSON.stringify(versions));
  });
});
