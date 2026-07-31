import { Document } from 'mongodb';
import {
  BillRow,
  BillingQueryRepository,
  DailyRollupRow,
  MonthlyRollupRow,
} from '../../../../application/interfaces/billing-query-repository.js';
import { TokenType } from '../../../../domain/models/price-version-model.js';
import { CostByTokenType } from '../../../../domain/useCases/get-billing-series-use-case.js';
import { PendingPriceSummary } from '../../../../domain/useCases/get-billing-summary-use-case.js';
import { BillingUsageRecord } from '../../../../domain/models/billing-snapshot-model.js';
import { ModelRef, modelKey } from '../../../../domain/models/model-ref.js';
import { MongoDb } from '../mongo-db.js';
import { TRACES_COLLECTION } from '../trace/mongodb-trace-repository.js';

/**
 * Billing reads the SAME traces collection the tabs read and sums the SAME
 * ingestion-time stamps (invariants 1 and 3). µ¢ sums stay exact: integers
 * below 2^53 are exact under Mongo's $sum.
 */
export class MongoDbBillingQueryRepository implements BillingQueryRepository {
  async listBills(): Promise<BillRow[]> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    const documents = (await traces
      .aggregate([
        {
          $project: {
            // $year/$month operate in UTC by default — same calendar-month
            // boundary monthWindowUtc uses for the summary.
            year: { $year: '$startedAt' },
            month: { $month: '$startedAt' },
            pricingStatus: 1,
            totalCostMicrocents: 1,
            tokens: 1,
          },
        },
        {
          $group: {
            _id: { year: '$year', month: '$month' },
            stampedTraceCount: {
              $sum: { $cond: [{ $eq: ['$pricingStatus', 'stamped'] }, 1, 0] },
            },
            pendingTraceCount: {
              $sum: {
                $cond: [{ $eq: ['$pricingStatus', 'pending_price'] }, 1, 0],
              },
            },
            totalCostMicrocents: {
              $sum: {
                $cond: [
                  { $eq: ['$pricingStatus', 'stamped'] },
                  { $ifNull: ['$totalCostMicrocents', 0] },
                  0,
                ],
              },
            },
            tokens: {
              $sum: {
                $add: [
                  { $ifNull: ['$tokens.input', 0] },
                  { $ifNull: ['$tokens.output', 0] },
                  { $ifNull: ['$tokens.cache_read', 0] },
                  { $ifNull: ['$tokens.cache_write', 0] },
                ],
              },
            },
          },
        },
        { $sort: { '_id.year': -1, '_id.month': -1 } },
      ])
      .toArray()) as {
      _id: { year: number; month: number };
      stampedTraceCount: number;
      pendingTraceCount: number;
      totalCostMicrocents: number;
      tokens: number;
    }[];

    return documents.map((document) => ({
      year: document._id.year,
      month: document._id.month,
      totalCostMicrocents: document.totalCostMicrocents,
      stampedTraceCount: document.stampedTraceCount,
      pendingTraceCount: document.pendingTraceCount,
      tokens: document.tokens,
    }));
  }

  /**
   * The statement engine's diet (decision 88): one record per stamped
   * trace, stamps verbatim, never the payloads/spans (decision 47).
   * Deterministic order by traceId — snapshots must reproduce exactly.
   */
  async fetchUsageRecords(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BillingUsageRecord[]> {
    const documents = await MongoDb.getCollection(TRACES_COLLECTION)
      .find(
        {
          startedAt: { $gte: monthStart, $lt: monthEnd },
          pricingStatus: 'stamped',
        },
        {
          projection: {
            traceId: 1,
            startedAt: 1,
            agent: 1,
            model: 1,
            stampedCosts: 1,
            totalCostMicrocents: 1,
          },
          sort: { traceId: 1 },
        },
      )
      .toArray();

    return documents.map((document) => ({
      traceId: document.traceId as string,
      startedAt: document.startedAt as Date,
      agentId: (document.agent?.id as string | undefined) ?? null,
      agentVersion: (document.agent?.version as string | undefined) ?? null,
      model: document.model ? modelKey(document.model as ModelRef) : null,
      stampedCosts: (document.stampedCosts ?? []) as BillingUsageRecord['stampedCosts'],
      totalCostMicrocents: (document.totalCostMicrocents as number) ?? 0,
    }));
  }

  async pendingPriceSummary(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<PendingPriceSummary> {
    const [pendingDocument] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            startedAt: { $gte: monthStart, $lt: monthEnd },
            pricingStatus: 'pending_price',
          },
        },
        {
          $group: {
            _id: null,
            traceCount: { $sum: 1 },
            tokensInput: { $sum: { $ifNull: ['$tokens.input', 0] } },
            tokensOutput: { $sum: { $ifNull: ['$tokens.output', 0] } },
            tokensCacheRead: { $sum: { $ifNull: ['$tokens.cache_read', 0] } },
            tokensCacheWrite: { $sum: { $ifNull: ['$tokens.cache_write', 0] } },
            models: { $addToSet: { $ifNull: ['$model', null] } },
          },
        },
      ])
      .toArray()) as Document[];

    return {
      traceCount: pendingDocument?.traceCount ?? 0,
      tokens: {
        input: pendingDocument?.tokensInput ?? 0,
        output: pendingDocument?.tokensOutput ?? 0,
        cache_read: pendingDocument?.tokensCacheRead ?? 0,
        cache_write: pendingDocument?.tokensCacheWrite ?? 0,
      },
      models: (pendingDocument?.models ?? [])
        .filter((model: ModelRef | null): model is ModelRef => model !== null)
        .map(modelKey)
        .sort(),
    };
  }

  async monthlyRollup(): Promise<MonthlyRollupRow[]> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);

    const monthOf = {
      year: { $year: '$startedAt' },
      month: { $month: '$startedAt' },
    };

    // Two pipelines over the UNWOUND stamps — (month × agent × type) and
    // (month × model × type); every coarser sum (agent totals, month
    // totals, month type split) is assembled from them in JS.
    const stampStages = [
      { $match: { pricingStatus: 'stamped' } },
      { $project: { startedAt: 1, agent: 1, model: 1, stampedCosts: 1 } },
      { $unwind: '$stampedCosts' },
    ];

    const byAgentType = (await traces
      .aggregate([
        ...stampStages,
        {
          $group: {
            _id: {
              ...monthOf,
              agentId: { $ifNull: ['$agent.id', null] },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
      ])
      .toArray()) as Document[];

    const byModelType = (await traces
      .aggregate([
        ...stampStages,
        {
          $group: {
            _id: {
              ...monthOf,
              model: { $ifNull: ['$model', null] },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
      ])
      .toArray()) as Document[];

    const rows = new Map<string, MonthlyRollupRow>();

    const rowOf = (year: number, month: number): MonthlyRollupRow => {
      const key = `${year}-${month}`;
      let row = rows.get(key);

      if (!row) {
        row = {
          year,
          month,
          totalCostMicrocents: 0,
          byTokenType: [],
          byAgent: [],
          byModel: [],
        };
        rows.set(key, row);
      }

      return row;
    };

    const addTokenCost = (
      split: CostByTokenType,
      tokenType: TokenType,
      costMicrocents: number,
    ): void => {
      const entry = split.find((candidate) => candidate.tokenType === tokenType);

      if (entry) {
        entry.costMicrocents += costMicrocents;
      } else {
        split.push({ tokenType, costMicrocents });
      }
    };

    for (const document of byAgentType) {
      const row = rowOf(document._id.year, document._id.month);
      const tokenType = document._id.tokenType as TokenType;

      // Every stamped trace has an agent slot (null included), so the
      // agent×type rows also feed the month total and its type split.
      row.totalCostMicrocents += document.costMicrocents;
      addTokenCost(row.byTokenType, tokenType, document.costMicrocents);

      let agent = row.byAgent.find(
        (candidate) => candidate.agentId === document._id.agentId,
      );

      if (!agent) {
        agent = {
          agentId: document._id.agentId,
          costMicrocents: 0,
          byTokenType: [],
        };
        row.byAgent.push(agent);
      }

      agent.costMicrocents += document.costMicrocents;
      addTokenCost(agent.byTokenType, tokenType, document.costMicrocents);
    }

    for (const document of byModelType) {
      const row = rowOf(document._id.year, document._id.month);
      const model = document._id.model ? modelKey(document._id.model) : null;

      let entry = row.byModel.find((candidate) => candidate.model === model);

      if (!entry) {
        entry = { model, costMicrocents: 0, byTokenType: [] };
        row.byModel.push(entry);
      }

      entry.costMicrocents += document.costMicrocents;
      addTokenCost(
        entry.byTokenType,
        document._id.tokenType as TokenType,
        document.costMicrocents,
      );
    }

    for (const row of rows.values()) {
      row.byAgent.sort((a, b) => b.costMicrocents - a.costMicrocents);
      row.byModel.sort((a, b) => b.costMicrocents - a.costMicrocents);
    }

    return [...rows.values()].sort(
      (a, b) => a.year - b.year || a.month - b.month,
    );
  }

  async dailyRollup(from: Date, toExclusive: Date): Promise<DailyRollupRow[]> {
    const documents = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            startedAt: { $gte: from, $lt: toExclusive },
            pricingStatus: 'stamped',
            // Quarantined traces are outside every bill (T6) — excluding
            // them keeps a closed month's days summing to its frozen
            // total (decision 97).
            'billingQuarantine.reason': { $exists: false },
          },
        },
        { $project: { startedAt: 1, stampedCosts: 1 } },
        { $unwind: '$stampedCosts' },
        {
          $group: {
            _id: {
              day: {
                $dateTrunc: { date: '$startedAt', unit: 'day', timezone: 'UTC' },
              },
              tokenType: '$stampedCosts.tokenType',
            },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
        { $sort: { '_id.day': 1 } },
      ])
      .toArray()) as Document[];

    const rows = new Map<number, DailyRollupRow>();

    for (const document of documents) {
      const date = document._id.day as Date;
      let row = rows.get(date.getTime());

      if (!row) {
        row = { date, totalCostMicrocents: 0, byTokenType: [] };
        rows.set(date.getTime(), row);
      }

      row.totalCostMicrocents += document.costMicrocents;
      row.byTokenType.push({
        tokenType: document._id.tokenType as TokenType,
        costMicrocents: document.costMicrocents,
      });
    }

    return [...rows.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    );
  }

  async ingestionWatermark(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<Date | null> {
    const [document] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        { $match: { startedAt: { $gte: monthStart, $lt: monthEnd } } },
        { $group: { _id: null, watermark: { $max: '$ingestedAt' } } },
      ])
      .toArray()) as Document[];

    return (document?.watermark as Date | undefined) ?? null;
  }

  async countQuarantined(monthStart: Date, monthEnd: Date): Promise<number> {
    return MongoDb.getCollection(TRACES_COLLECTION).countDocuments({
      startedAt: { $gte: monthStart, $lt: monthEnd },
      'billingQuarantine.reason': { $exists: true },
    });
  }

  async accruedCostMicrocents(monthStart: Date, upTo: Date): Promise<number> {
    const [document] = (await MongoDb.getCollection(TRACES_COLLECTION)
      .aggregate([
        {
          $match: {
            startedAt: { $gte: monthStart, $lt: upTo },
            pricingStatus: 'stamped',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$totalCostMicrocents', 0] } },
          },
        },
      ])
      .toArray()) as Document[];

    return (document?.total as number | undefined) ?? 0;
  }
}
