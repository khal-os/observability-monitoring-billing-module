/**
 * Billing integration — including the MANDATORY consistency check of the
 * PoC: billing summary ≡ Σ stamped trace costs, recomputed INDEPENDENTLY
 * in plain JS from the raw stored traces (no aggregation pipeline reuse).
 */
import request from 'supertest';
import { server } from '../../app.js';
import { makeReprocessPendingUseCase } from '../../../factories/sync-factory.js';
import { makePriceVersionRepository } from '../../../factories/price-factory.js';
import {
  routeDbHarness,
  StoredTraceRecord,
} from './helpers/route-db-harness.js';
import {
  brlToMicrocents,
  formatBrlExactFromMicrocents,
  formatBrlFromMicrocents,
} from '../../../../common/helpers/money/money.js';
import { StampedTokenCost } from '../../../../domain/models/trace-model.js';

const app = server.app;

const FORBIDDEN_INTERNAL_KEYS =
  /marketPriceUsd|ptaxReference|markupPercent|Microcents|microcents|"_id"/;

const juneTracesFromDb = async (): Promise<StoredTraceRecord[]> =>
  routeDbHarness.readTracesBetween(
    new Date('2026-06-01T00:00:00.000Z'),
    new Date('2026-07-01T00:00:00.000Z'),
  );

describe('Billing Routes', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('GET /api/v1/bills', () => {
    it('MUST list bills with the SAME totals the month statement reports', async () => {
      const billsResponse = await request(app)
        .get('/api/v1/bills')
        .expect(200);
      const june = billsResponse.body.bills.find(
        (bill: { year: number; month: number }) =>
          bill.year === 2026 && bill.month === 6,
      );

      expect(june).toBeDefined();

      const summaryResponse = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      // One store, one truth: the bill line and the month statement agree.
      expect(june.total_cost_brl).toBe(summaryResponse.body.total_cost_brl);
      expect(june.pending_trace_count).toBe(
        summaryResponse.body.pending_price.trace_count,
      );
      expect(june.period_status).toBe(summaryResponse.body.period_status);

      const traces = await juneTracesFromDb();

      expect(june.stamped_trace_count).toBe(
        traces.filter((trace) => trace.pricingStatus === 'stamped').length,
      );
      expect(FORBIDDEN_INTERNAL_KEYS.test(JSON.stringify(billsResponse.body))).toBe(
        false,
      );
    });
  });

  describe('GET /api/v1/billing/summary — validation', () => {
    it('MUST return 400 for missing or malformed year/month', async () => {
      await request(app).get('/api/v1/billing/summary').expect(400);
      await request(app)
        .get('/api/v1/billing/summary?year=2026')
        .expect(400);
      await request(app)
        .get('/api/v1/billing/summary?month=6')
        .expect(400);
      await request(app)
        .get('/api/v1/billing/summary?year=2026&month=13')
        .expect(400);
      await request(app)
        .get('/api/v1/billing/summary?year=abc&month=6')
        .expect(400);
    });
  });

  describe('MANDATORY consistency check: summary ≡ Σ stamped costs', () => {
    it('MUST equal the independent recomputation from raw stored traces', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      // Independent recomputation: plain JS over raw documents.
      const traces = await juneTracesFromDb();
      const stamped = traces.filter(
        (trace) => trace.pricingStatus === 'stamped',
      );

      const independentTotal = stamped.reduce(
        (sum, trace) => sum + (trace.totalCostMicrocents ?? 0),
        0,
      );

      expect(response.body.total_cost_brl).toBe(
        formatBrlFromMicrocents(independentTotal),
      );

      // Line-by-line: group stamps by agent × model × token type in JS.
      const independentLines = new Map<
        string,
        { tokens: number; costMicrocents: number }
      >();

      for (const trace of stamped) {
        for (const cost of trace.stampedCosts ?? []) {
          // Same recomposition rule as the API: provider/id, or the bare
          // id when the provider is unknown.
          const storedModelKey = trace.model
            ? trace.model.provider
              ? `${trace.model.provider}/${trace.model.id}`
              : trace.model.id
            : null;
          const key = `${trace.agent?.id ?? null}|${trace.agent?.version ?? null}|${storedModelKey}|${cost.tokenType}`;
          const line = independentLines.get(key) ?? {
            tokens: 0,
            costMicrocents: 0,
          };

          line.tokens += cost.tokens;
          line.costMicrocents += cost.costMicrocents;
          independentLines.set(key, line);
        }
      }

      expect(response.body.lines).toHaveLength(independentLines.size);

      for (const line of response.body.lines) {
        const independent = independentLines.get(
          `${line.agent_id}|${line.agent_version}|${line.model}|${line.token_type}`,
        );

        expect(independent).toBeDefined();
        expect(line.tokens).toBe(independent?.tokens);
        // Per-line cost pinned to the independent grouping — misattribution
        // between lines cannot cancel out through the total.
        expect(line.cost_brl_exact).toBe(
          formatBrlExactFromMicrocents(independent?.costMicrocents as number),
        );
      }

      // The sum of every trace's stamped total equals the sum of all lines
      // — same stamp, one truth (invariant 3).
      const lineSum = [...independentLines.values()].reduce(
        (sum, line) => sum + line.costMicrocents,
        0,
      );

      expect(lineSum).toBe(independentTotal);
    });

    it('MUST make displayed line values close with the displayed total (T5)', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      const displayedSumCents = response.body.lines.reduce(
        (sum: number, line: { cost_brl_display: string }) =>
          sum + Math.round(Number(line.cost_brl_display) * 100),
        0,
      );

      expect(displayedSumCents).toBe(
        Math.round(Number(response.body.total_cost_brl) * 100),
      );
    });
  });

  describe('Pending price reported APART (invariant 2)', () => {
    it('MUST count pending traces and tokens outside the R$ total', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(response.body.pending_price).toEqual({
        trace_count: 2,
        tokens: { input: 6000, output: 1100, cache_read: 0, cache_write: 0 },
        tokens_total: 7100,
        tokens_total_display: '7.100',
        models: ['meta/llama-4-scout'],
        models_label: 'meta/llama-4-scout',
      });

      expect(response.body.period_status).toBe('open');
      expect(response.body.partial).toBe(false);
    });
  });

  describe('Demo step 7: register missing price → reprocess → totals grow', () => {
    it('MUST absorb reprocessed traces into the totals and empty the pending queue', async () => {
      const before = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      const priceRepository = makePriceVersionRepository();

      for (const [tokenType, price] of [
        ['input', '1.00'],
        ['output', '4.00'],
      ] as const) {
        await priceRepository.insertVersion({
          model: 'meta/llama-4-scout',
          tokenType,
          pricingType: 'fixed_brl',
          priceMicrocentsPerMillion: brlToMicrocents(price),
          effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        });
      }

      await makeReprocessPendingUseCase().reprocess();

      const after = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(after.body.pending_price.trace_count).toBe(0);
      expect(after.body.lines.length).toBeGreaterThan(
        before.body.lines.length,
      );

      // Consistency must hold again after reprocessing.
      const traces = await juneTracesFromDb();
      const independentTotal = traces
        .filter((trace) => trace.pricingStatus === 'stamped')
        .reduce((sum, trace) => sum + (trace.totalCostMicrocents ?? 0), 0);

      expect(after.body.total_cost_brl).toBe(
        formatBrlFromMicrocents(independentTotal),
      );

      // Re-establish the pristine ingested state for other assertions.
      await routeDbHarness.ingestJuneFixtures();
    });
  });

  describe('Empty month', () => {
    it('MUST answer honestly with zeros for a month with no data', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=1')
        .expect(200);

      expect(response.body.total_cost_brl).toBe('0.00');
      expect(response.body.lines).toEqual([]);
      expect(response.body.pending_price.trace_count).toBe(0);
    });
  });

  describe('Projection schema (invariant 4)', () => {
    it('MUST NOT leak internal fields (US$, PTAX, markup, µ¢, _id)', async () => {
      const response = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(JSON.stringify(response.body)).not.toMatch(
        FORBIDDEN_INTERNAL_KEYS,
      );
    });
  });
});
