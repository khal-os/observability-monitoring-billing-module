import { Document } from 'mongodb';
import {
  BillingMonthAggregate,
  BillRow,
  BillingQueryRepository,
} from '../../../../data/interfaces/billing-query-repository.js';
import { BillingSummaryLine } from '../../../../core/useCases/get-billing-summary-use-case.js';
import { TokenType } from '../../../../core/models/price-version-model.js';
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

  async aggregateMonth(
    monthStart: Date,
    monthEnd: Date,
  ): Promise<BillingMonthAggregate> {
    const traces = MongoDb.getCollection(TRACES_COLLECTION);
    const windowMatch = { startedAt: { $gte: monthStart, $lt: monthEnd } };

    const lineDocuments = (await traces
      .aggregate([
        { $match: { ...windowMatch, pricingStatus: 'stamped' } },
        // Early projection: the pipeline never carries payloads/spans
        // (merged into the trace document — decision 47).
        { $project: { agent: 1, model: 1, stampedCosts: 1 } },
        { $unwind: '$stampedCosts' },
        {
          $group: {
            // Lines break down by agent id AND version (decision 48):
            // cost per release is visible in the statement.
            _id: {
              agentId: { $ifNull: ['$agent.id', null] },
              agentVersion: { $ifNull: ['$agent.version', null] },
              model: { $ifNull: ['$model', null] },
              tokenType: '$stampedCosts.tokenType',
            },
            tokens: { $sum: '$stampedCosts.tokens' },
            costMicrocents: { $sum: '$stampedCosts.costMicrocents' },
          },
        },
        {
          $sort: {
            '_id.agentId': 1,
            '_id.agentVersion': 1,
            '_id.model': 1,
            '_id.tokenType': 1,
          },
        },
      ])
      .toArray()) as {
      _id: {
        agentId: string | null;
        agentVersion: string | null;
        model: string | null;
        tokenType: TokenType;
      };
      tokens: number;
      costMicrocents: number;
    }[];

    const lines: BillingSummaryLine[] = lineDocuments.map((document) => ({
      agentId: document._id.agentId,
      agentVersion: document._id.agentVersion,
      model: document._id.model,
      tokenType: document._id.tokenType,
      tokens: document.tokens,
      costMicrocents: document.costMicrocents,
    }));

    const [pendingDocument] = (await traces
      .aggregate([
        { $match: { ...windowMatch, pricingStatus: 'pending_price' } },
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
      lines,
      pendingPrice: {
        traceCount: pendingDocument?.traceCount ?? 0,
        tokens: {
          input: pendingDocument?.tokensInput ?? 0,
          output: pendingDocument?.tokensOutput ?? 0,
          cache_read: pendingDocument?.tokensCacheRead ?? 0,
          cache_write: pendingDocument?.tokensCacheWrite ?? 0,
        },
        models: (pendingDocument?.models ?? [])
          .filter((model: string | null): model is string => model !== null)
          .sort(),
      },
    };
  }
}
