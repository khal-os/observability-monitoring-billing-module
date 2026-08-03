import {
  BillingUsageRecord,
  StatementAgentGroup,
  StatementAgentModelMix,
  StatementCacheSavings,
  StatementLine,
  StatementModelShare,
  StatementProjection,
} from '@observability/core/domain/models/billing-snapshot-model.js';
import {
  TOKEN_TYPES,
  TokenType,
} from '@observability/core/domain/models/price-version-model.js';
import {
  costMicrocents,
  reconcileDisplayCents,
  sumMicrocents,
} from '@observability/core/common/helpers/money/money.js';

/**
 * THE billing calculation (invariant 3 made mechanical): one pure function
 * from usage records (ingestion-time stamps, copied verbatim) to the full
 * month statement. The live path runs it on every read of an open month;
 * the close (T6) runs it once and freezes input AND output — so
 * closed ≡ live-at-close-time, and the reproducibility acceptance test is
 * simply `buildStatement(snapshot inputs) === snapshot output`.
 *
 * Bump LOGIC_VERSION on ANY change to the math in this file — snapshots
 * record the version that produced them (T6 audit).
 *
 * v2 (decision 109): share/basis-point math and every µ¢ accumulation
 * moved to BigInt/assert-safe integer arithmetic (money-module
 * discipline) — deterministic before and after; the bump marks the change.
 *
 * v2 STAYS at decision 122 (re-audit iteration 4): completing the line and
 * price-version comparators into total orders changed no arithmetic — it
 * only DEFINES an order that used to fall through to Map-insertion order.
 * Any statement that was reproducible before is byte-identical after, so
 * bumping would falsely mark every frozen snapshot as produced by a
 * different calculation.
 */
export const STATEMENT_LOGIC_VERSION = 'statement-engine/2';

export const STATEMENT_ROUNDING_RULE =
  'Custos em micro-centavos inteiros (1e-8 R$); linha mantém precisão ' +
  'total; exibição arredonda half-up em 2 casas com reconciliação ' +
  'largest-remainder (partes exibidas fecham exatamente com o total exibido).';

const nullableCompare = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;

  return a < b ? -1 : 1;
};

/**
 * TOTAL order over `lineKey` — every field the accumulator groups by is a
 * sort term, the applied unit price included (re-audit iteration 4).
 * Without the price term two distinct lines compared EQUAL, and a stable
 * sort then left them in Map-INSERTION order: the day-paged close (T6)
 * and the whole-month live read feed the same records in different
 * orders, so the same line landed at a different index — and
 * `reconcileDisplayCents` breaks its remainder ties BY INDEX, so the same
 * line could be exported at R$ 0,02 live and R$ 0,01 frozen. A comparator
 * that is total on the group key is what makes "the engine is
 * order-independent" a property instead of an assumption.
 */
const compareLines = (a: StatementLine, b: StatementLine): number =>
  nullableCompare(a.agentId, b.agentId) ||
  nullableCompare(a.agentVersion, b.agentVersion) ||
  nullableCompare(a.model, b.model) ||
  TOKEN_TYPES.indexOf(a.tokenType) - TOKEN_TYPES.indexOf(b.tokenType) ||
  a.appliedPriceEffectiveFrom.getTime() -
    b.appliedPriceEffectiveFrom.getTime() ||
  a.appliedPriceMicrocentsPerMillion - b.appliedPriceMicrocentsPerMillion;

/**
 * Largest-remainder allocation of `totalBp` (10000 = 100%) across exact
 * µ¢ weights: integer basis points that sum EXACTLY to totalBp. Ties break
 * by lowest index (deterministic — snapshots must reproduce bit-for-bit).
 *
 * BigInt end-to-end (money-module discipline): `weight × totalBp` exceeds
 * 2^53 well within the asserted µ¢ domain, so floors and remainder
 * ordering are computed on exact integers — never float division.
 */
const shareBasisPoints = (weights: number[], totalBp = 10_000): number[] => {
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);

  if (total === 0n) return weights.map(() => 0);

  const scaled = weights.map((weight) => BigInt(weight) * BigInt(totalBp));
  const floors = scaled.map((value) => Number(value / total));
  let deficit = totalBp - floors.reduce((sum, value) => sum + value, 0);

  const order = scaled
    .map((value, index) => ({ remainder: value % total, index }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : b.remainder > a.remainder
          ? 1
          : -1,
    );

  const shares = [...floors];

  for (const { index } of order) {
    if (deficit <= 0) break;
    shares[index] += 1;
    deficit -= 1;
  }

  return shares;
};

/**
 * Assert-safe accumulation for running µ¢ sums (the money module's rule:
 * exactness is asserted at every step, never assumed).
 */
const addMicrocents = (current: number, value: number): number =>
  sumMicrocents([current, value]);

/**
 * The null sentinel is U+0000 WRITTEN AS AN ESCAPE (re-audit iteration 4):
 * the character cannot occur in an agentId, agentVersion or model — a
 * space can, so "simplifying" it to ' ' would collide an unattributed
 * trace with a whitespace-named one. The escape (never the raw byte) keeps
 * this file text: with raw NULs git classified THE billing calculation as
 * a binary blob, so every change to it landed without a reviewable diff
 * and grep silently skipped it.
 */
const lineKey = (line: Omit<StatementLine, 'tokens' | 'costMicrocents' | 'displayCents'>): string =>
  [
    line.agentId ?? '\u0000',
    line.agentVersion ?? '\u0000',
    line.model ?? '\u0000',
    line.tokenType,
    line.appliedPriceMicrocentsPerMillion,
    line.appliedPriceEffectiveFrom.getTime(),
  ].join('@@');

/** Folds ONE record into the line accumulator (state = distinct lines). */
const addRecordLines = (
  groups: Map<string, StatementLine>,
  record: BillingUsageRecord,
): void => {
  for (const cost of record.stampedCosts) {
    const shape = {
      agentId: record.agentId,
      agentVersion: record.agentVersion,
      model: record.model,
      tokenType: cost.tokenType,
      appliedPriceMicrocentsPerMillion: cost.appliedPriceMicrocentsPerMillion,
      appliedPriceEffectiveFrom: cost.appliedPriceEffectiveFrom,
    };
    const key = lineKey(shape);
    const line = groups.get(key);

    if (line) {
      line.tokens += cost.tokens;
      line.costMicrocents = addMicrocents(
        line.costMicrocents,
        cost.costMicrocents,
      );
    } else {
      groups.set(key, {
        ...shape,
        tokens: cost.tokens,
        costMicrocents: cost.costMicrocents,
        displayCents: 0,
      });
    }
  }
};

/**
 * Exported so nobody hand-copies it — the month-over-month comparison did,
 * and reached for a space sentinel, which is exactly the collision the note
 * on lineKey forbids (re-audit iteration 6). One home for the rule.
 */
export const agentKey = (
  agentId: string | null,
  agentVersion: string | null,
): string => `${agentId ?? '\u0000'}@@${agentVersion ?? '\u0000'}`;

const buildAgentGroups = (lines: StatementLine[]): StatementAgentGroup[] => {
  const groups = new Map<string, StatementAgentGroup>();

  for (const line of lines) {
    const key = agentKey(line.agentId, line.agentVersion);
    let group = groups.get(key);

    if (!group) {
      group = {
        agentId: line.agentId,
        agentVersion: line.agentVersion,
        tokens: 0,
        costMicrocents: 0,
        displayCents: 0,
        percentOfTotalBp: 0,
        costByTokenTypeMicrocents: {},
      };
      groups.set(key, group);
    }

    group.tokens += line.tokens;
    group.costMicrocents = addMicrocents(
      group.costMicrocents,
      line.costMicrocents,
    );
    group.displayCents += line.displayCents;
    group.costByTokenTypeMicrocents[line.tokenType] = addMicrocents(
      group.costByTokenTypeMicrocents[line.tokenType] ?? 0,
      line.costMicrocents,
    );
  }

  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.costMicrocents - a.costMicrocents ||
      nullableCompare(a.agentId, b.agentId) ||
      nullableCompare(a.agentVersion, b.agentVersion),
  );

  const shares = shareBasisPoints(sorted.map((group) => group.costMicrocents));
  sorted.forEach((group, index) => {
    group.percentOfTotalBp = shares[index] as number;
  });

  return sorted;
};

const buildModelShares = (
  lines: StatementLine[],
  totals: { tokens: number; costMicrocents: number },
): StatementModelShare[] => {
  const byModel = new Map<string | null, StatementModelShare>();

  for (const line of lines) {
    let share = byModel.get(line.model);

    if (!share) {
      share = {
        model: line.model,
        tokens: 0,
        costMicrocents: 0,
        costShareBp: 0,
        tokenShareBp: 0,
      };
      byModel.set(line.model, share);
    }

    share.tokens += line.tokens;
    share.costMicrocents = addMicrocents(
      share.costMicrocents,
      line.costMicrocents,
    );
  }

  const sorted = [...byModel.values()].sort(
    (a, b) =>
      b.costMicrocents - a.costMicrocents || nullableCompare(a.model, b.model),
  );

  const costShares = shareBasisPoints(sorted.map((share) => share.costMicrocents));
  // Token share reconciles over the SAME statement's token total, so both
  // shares always close at 100% independently (T9: sempre fechando).
  const tokenShares = shareBasisPoints(
    sorted.map((share) => share.tokens),
    totals.tokens === 0 ? 0 : 10_000,
  );

  sorted.forEach((share, index) => {
    share.costShareBp = costShares[index] as number;
    share.tokenShareBp = tokenShares[index] as number;
  });

  return sorted;
};

const buildModelMixByAgent = (
  lines: StatementLine[],
  agents: StatementAgentGroup[],
): StatementAgentModelMix[] =>
  agents.map((agent) => {
    const agentLines = lines.filter(
      (line) =>
        line.agentId === agent.agentId &&
        line.agentVersion === agent.agentVersion,
    );

    return {
      agentId: agent.agentId,
      agentVersion: agent.agentVersion,
      models: buildModelShares(agentLines, {
        tokens: agent.tokens,
        costMicrocents: agent.costMicrocents,
      }),
      blendedPricePerMillionMicrocents:
        agent.tokens > 0 ? blendedPerMillion(agent) : null,
    };
  });

/** Group cost ÷ group tokens × 1M, half-up at the µ¢ (derived, display-only). */
const blendedPerMillion = (agent: StatementAgentGroup): number => {
  const numerator = BigInt(agent.costMicrocents) * 1_000_000n;
  const denominator = BigInt(agent.tokens);

  return Number((numerator + denominator / 2n) / denominator);
};

/**
 * Cache-economics accumulator — same math as before, one record at a time.
 * State is bounded by the distinct applied INPUT prices, never by the
 * record count.
 */
const createCacheSavingsFold = (): {
  add: (record: BillingUsageRecord) => void;
  finish: () => StatementCacheSavings;
} => {
  let cacheReadTokens = 0;
  let actualCacheReadCostMicrocents = 0;
  let cacheWriteCostMicrocents = 0;
  let unpriceableCacheReadTraces = 0;

  // Counterfactual buckets: cache_read tokens grouped by the INPUT price
  // applied on the SAME trace (decision 91) — then priced once per bucket,
  // half-up at the µ¢, so the metric is deterministic and reproducible.
  const counterfactualBuckets = new Map<number, number>();

  return {
    add: (record) => {
      const read = record.stampedCosts.find((cost) => cost.tokenType === 'cache_read');
      const write = record.stampedCosts.find((cost) => cost.tokenType === 'cache_write');
      const input = record.stampedCosts.find((cost) => cost.tokenType === 'input');

      if (write) {
        cacheWriteCostMicrocents = addMicrocents(
          cacheWriteCostMicrocents,
          write.costMicrocents,
        );
      }

      if (!read || read.tokens === 0) return;

      cacheReadTokens += read.tokens;
      actualCacheReadCostMicrocents = addMicrocents(
        actualCacheReadCostMicrocents,
        read.costMicrocents,
      );

      if (!input) {
        unpriceableCacheReadTraces += 1;

        return;
      }

      counterfactualBuckets.set(
        input.appliedPriceMicrocentsPerMillion,
        (counterfactualBuckets.get(input.appliedPriceMicrocentsPerMillion) ?? 0) +
          read.tokens,
      );
    },
    finish: () => {
      const counterfactualInputCostMicrocents = sumMicrocents(
        [...counterfactualBuckets.entries()].map(([price, tokens]) =>
          costMicrocents(tokens, price),
        ),
      );

      const savingsMicrocents =
        counterfactualInputCostMicrocents - actualCacheReadCostMicrocents;

      return {
        cacheReadTokens,
        actualCacheReadCostMicrocents,
        counterfactualInputCostMicrocents,
        savingsMicrocents,
        cacheWriteCostMicrocents,
        netSavingsMicrocents: savingsMicrocents - cacheWriteCostMicrocents,
        unpriceableCacheReadTraces,
      };
    },
  };
};

/** One distinct price version applied in the month (snapshot audit view). */
export interface AppliedPriceVersion {
  model: string | null;
  tokenType: TokenType;
  priceMicrocentsPerMillion: number;
  effectiveFrom: Date;
}

/** Folds ONE record into the applied-versions accumulator (distinct keys). */
const addRecordPriceVersions = (
  seen: Map<string, AppliedPriceVersion>,
  record: BillingUsageRecord,
): void => {
  for (const cost of record.stampedCosts) {
    const key = [
      record.model ?? '\u0000',
      cost.tokenType,
      cost.appliedPriceMicrocentsPerMillion,
      cost.appliedPriceEffectiveFrom.getTime(),
    ].join('@@');

    if (!seen.has(key)) {
      seen.set(key, {
        model: record.model,
        tokenType: cost.tokenType,
        priceMicrocentsPerMillion: cost.appliedPriceMicrocentsPerMillion,
        effectiveFrom: cost.appliedPriceEffectiveFrom,
      });
    }
  }
};

/**
 * THE calculation, in accumulator form (re-audit iteration 3). Identical
 * arithmetic to `buildStatement` — it IS `buildStatement`'s body — but the
 * month never has to be resident: the state is the distinct statement
 * lines, agent/model keys and applied price versions, so it is bounded by
 * DISTINCT KEYS, not by the number of traces. The close (T6) folds the
 * month page by page through this; `buildStatement` below is the same fold
 * over an array, so both paths run ONE calculation (invariant 3, T7).
 *
 * `statement()`/`appliedPriceVersions()` are pure over the accumulators:
 * calling either again (or after more `add`s) recomputes, never caches.
 * LOGIC_VERSION does NOT move for this — no math changed.
 */
export interface StatementFold {
  add(record: BillingUsageRecord): void;
  /** Stamped traces folded so far — the snapshot's usageRecordCount. */
  recordCount(): number;
  statement(): StatementProjection;
  appliedPriceVersions(): AppliedPriceVersion[];
}

export const createStatementFold = (): StatementFold => {
  const groups = new Map<string, StatementLine>();
  const cacheSavings = createCacheSavingsFold();
  const priceVersions = new Map<string, AppliedPriceVersion>();
  let recordCount = 0;

  return {
    add: (record) => {
      recordCount += 1;
      addRecordLines(groups, record);
      cacheSavings.add(record);
      addRecordPriceVersions(priceVersions, record);
    },
    recordCount: () => recordCount,
    statement: () =>
      finishStatement(
        [...groups.values()].sort(compareLines),
        cacheSavings.finish(),
        recordCount,
      ),
    appliedPriceVersions: () => sortPriceVersions([...priceVersions.values()]),
  };
};

const finishStatement = (
  lines: StatementLine[],
  cacheSavings: StatementCacheSavings,
  stampedTraceCount: number,
): StatementProjection => {
  // Invariant 3: the total IS the sum of the stamped line costs.
  const totalCostMicrocents = sumMicrocents(
    lines.map((line) => line.costMicrocents),
  );

  const { totalCents, partsCents } = reconcileDisplayCents(
    lines.map((line) => line.costMicrocents),
  );
  lines.forEach((line, index) => {
    line.displayCents = partsCents[index] as number;
  });

  const agents = buildAgentGroups(lines);
  const stampedTokensTotal = lines.reduce((sum, line) => sum + line.tokens, 0);

  return {
    totalCostMicrocents,
    totalDisplayCents: totalCents,
    stampedTraceCount,
    stampedTokensTotal,
    lines,
    agents,
    modelMixTotal: buildModelShares(lines, {
      tokens: stampedTokensTotal,
      costMicrocents: totalCostMicrocents,
    }),
    modelMixByAgent: buildModelMixByAgent(lines, agents),
    cacheSavings,
  };
};

/** The twin of `compareLines`: total over `addRecordPriceVersions`' key. */
const sortPriceVersions = (
  versions: AppliedPriceVersion[],
): AppliedPriceVersion[] =>
  versions.sort(
    (a, b) =>
      nullableCompare(a.model, b.model) ||
      TOKEN_TYPES.indexOf(a.tokenType) - TOKEN_TYPES.indexOf(b.tokenType) ||
      a.effectiveFrom.getTime() - b.effectiveFrom.getTime() ||
      a.priceMicrocentsPerMillion - b.priceMicrocentsPerMillion,
  );

/** The same fold over a materialized array — the live read path's shape. */
const foldRecords = (records: BillingUsageRecord[]): StatementFold => {
  const fold = createStatementFold();

  for (const record of records) {
    fold.add(record);
  }

  return fold;
};

export const buildStatement = (
  records: BillingUsageRecord[],
): StatementProjection => foldRecords(records).statement();

/** Distinct price versions applied across the records (snapshot audit view). */
export const collectAppliedPriceVersions = (
  records: BillingUsageRecord[],
): AppliedPriceVersion[] => foldRecords(records).appliedPriceVersions();
