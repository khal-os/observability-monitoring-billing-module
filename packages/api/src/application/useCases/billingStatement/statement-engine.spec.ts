import {
  buildStatement,
  collectAppliedPriceVersions,
  createStatementFold,
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

  it('stays exact at extreme magnitude: shares and cents close near 2^53 µ¢ (decision 109)', () => {
    // Three agents at ≈3e15 µ¢ each — statement total is MAX_SAFE − 1, the
    // money module's asserted ceiling. weight × 10000 far exceeds 2^53, so
    // only BigInt share math keeps the allocation exact; everything must
    // still close, deterministically.
    const HUGE = 3_002_399_751_580_330; // ×3 = 9_007_199_254_740_990 = MAX_SAFE − 1
    const statement = buildStatement([
      record('h1', 'a', 'm1', [stamped('input', 1_000_000, HUGE)]),
      record('h2', 'b', 'm2', [stamped('input', 1_000_000, HUGE)]),
      record('h3', 'c', 'm3', [stamped('input', 1_000_000, HUGE)]),
    ]);

    expect(statement.totalCostMicrocents).toBe(Number.MAX_SAFE_INTEGER - 1);

    const totalBp = statement.agents.reduce(
      (sum, group) => sum + group.percentOfTotalBp,
      0,
    );
    expect(totalBp).toBe(10_000);
    expect(
      statement.modelMixTotal.reduce((sum, share) => sum + share.costShareBp, 0),
    ).toBe(10_000);

    const lineCents = statement.lines.reduce(
      (sum, line) => sum + line.displayCents,
      0,
    );
    expect(lineCents).toBe(statement.totalDisplayCents);
  });

  it('is DETERMINISTIC: same records in any order produce the identical statement (reproducibility, T6)', () => {
    const forward = buildStatement(FIXTURE);
    const reversed = buildStatement([...FIXTURE].reverse());

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(forward));
  });

  /**
   * Re-audit iteration 4 — the shape that reversing FIXTURE cannot reach.
   *
   * Two records identical in EVERY dimension the old comparator sorted by
   * (agentId, agentVersion, model, tokenType, appliedPriceEffectiveFrom)
   * and differing ONLY in the applied unit price. The accumulator keys the
   * line on the price too (decision 90 — a mid-month price change gets its
   * own line), so these are two DISTINCT lines that compared EQUAL; a
   * stable sort then left them in Map-INSERTION order, which is the order
   * the records arrived in.
   *
   * That is reachable: migration 019 (decision 102) lowercases
   * `traces.model` while leaving a colliding case-variant price row as
   * stored, so two stamps with the same (model, tokenType, effectiveFrom)
   * and different prices end up under one canonical model key.
   *
   * The two orders below are the exact two the deployment uses:
   *   (a) `GetBillingSummaryDbUseCase.monthStatement` and the T6
   *       reproducibility rebuild — whole month, sorted by traceId;
   *   (b) `CloseBillingPeriodDbUseCase.close` — a fold fed one UTC day at
   *       a time, each day sorted by traceId (decision 120).
   */
  describe('order-independence under a PRICE-only tie (decision 122)', () => {
    const TIE_FROM = new Date('2026-06-01T00:00:00Z');
    const CHEAP = 1_500_000; // 1,5 centavo on 1M tokens — half a cent
    const DEAR = 2_500_000; // 2,5 centavos on 1M tokens — half a cent
    const OTHER_AGENT_PRICE = 2_000_000;

    const tieRecord = (
      traceId: string,
      day: string,
      agentId: string,
      price: number,
    ): BillingUsageRecord => ({
      traceId,
      startedAt: new Date(`2026-06-${day}T10:00:00Z`),
      agentId,
      agentVersion: '1.0.0',
      model: 'anthropic/claude-x',
      stampedCosts: [stamped('input', 1_000_000, price, TIE_FROM)],
      totalCostMicrocents: costMicrocents(1_000_000, price),
    });

    /**
     * traceId order is the REVERSE of day order, so the two feeds really
     * do differ. The `suporte` record ties on the price-version key
     * (model, tokenType, effectiveFrom — no agent) without tying on the
     * line key, which is the twin comparator's own blind spot.
     */
    const TIE_MONTH: BillingUsageRecord[] = [
      tieRecord('z-cheap', '02', 'eugenia', CHEAP),
      tieRecord('m-other', '10', 'suporte', OTHER_AGENT_PRICE),
      tieRecord('a-dear', '20', 'eugenia', DEAR),
    ];

    /** The live read: whole month, globally sorted by traceId. */
    const liveOrder = () =>
      [...TIE_MONTH].sort((a, b) => (a.traceId < b.traceId ? -1 : 1));

    /** The close: one UTC day at a time, each page sorted by traceId. */
    const closeFold = () => {
      const fold = createStatementFold();
      const days = [
        ...new Set(
          TIE_MONTH.map((r) => r.startedAt.toISOString().slice(0, 10)),
        ),
      ].sort();

      for (const day of days) {
        const page = TIE_MONTH.filter(
          (r) => r.startedAt.toISOString().slice(0, 10) === day,
        ).sort((a, b) => (a.traceId < b.traceId ? -1 : 1));

        for (const record of page) fold.add(record);
      }

      return fold;
    };

    it('the LIVE (whole-month, traceId) and CLOSE (day-paged) statements are byte-identical', () => {
      const live = buildStatement(liveOrder());
      const closed = closeFold().statement();

      expect(JSON.stringify(closed)).toBe(JSON.stringify(live));
    });

    it('LINE ORDER is pinned by the applied price, not by arrival', () => {
      const live = buildStatement(liveOrder());
      const closed = closeFold().statement();

      const shape = (statement: typeof live) =>
        statement.lines.map((line) => [
          line.agentId,
          line.appliedPriceMicrocentsPerMillion,
        ]);

      const expected = [
        ['eugenia', CHEAP],
        ['eugenia', DEAR],
        ['suporte', OTHER_AGENT_PRICE],
      ];

      expect(shape(live)).toEqual(expected);
      expect(shape(closed)).toEqual(expected);
    });

    it('DISPLAYED cents are pinned too: the half-cent tie cannot move with the feed', () => {
      // Every line is exactly half a centavo over its floor except the
      // 2,00-centavo one, so `reconcileDisplayCents` has a 1-cent deficit
      // and breaks the remainder tie BY INDEX — the same line was
      // exported at R$ 0,03 live and R$ 0,02 frozen before this order was
      // total. Total is 6 centavos either way; WHICH line carries the
      // cent is what invariant 3 requires to be one truth.
      const live = buildStatement(liveOrder());
      const closed = closeFold().statement();

      expect(live.totalDisplayCents).toBe(6);
      expect(live.lines.map((line) => line.displayCents)).toEqual([2, 2, 2]);
      expect(closed.lines.map((line) => line.displayCents)).toEqual([2, 2, 2]);
    });

    it('priceVersionsApplied is ordered by price too — the audit view of the bill', () => {
      const live = collectAppliedPriceVersions(liveOrder());
      const closed = closeFold().appliedPriceVersions();

      const prices = [CHEAP, OTHER_AGENT_PRICE, DEAR];

      expect(live.map((version) => version.priceMicrocentsPerMillion)).toEqual(
        prices,
      );
      expect(
        closed.map((version) => version.priceMicrocentsPerMillion),
      ).toEqual(prices);
      expect(JSON.stringify(closed)).toBe(JSON.stringify(live));
    });
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
