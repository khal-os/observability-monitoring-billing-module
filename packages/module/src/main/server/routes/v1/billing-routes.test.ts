/**
 * Billing integration — including the MANDATORY consistency check of the
 * PoC: billing summary ≡ Σ stamped trace costs, recomputed INDEPENDENTLY
 * in plain JS from the raw stored traces (no aggregation pipeline reuse).
 */
import request from 'supertest';
import { server } from '../../app.js';
import { makeReprocessPendingUseCase } from '@observability/connector/main/factories/sync-factory.js';
import { makePriceVersionRepository } from '../../../factories/price-factory.js';
import {
  routeDbHarness,
  StoredTraceRecord,
} from './helpers/route-db-harness.js';
import {
  brlToMicrocents,
  formatBrlExactFromMicrocents,
  formatBrlFromMicrocents,
} from '@observability/core/common/helpers/money/money.js';
import { formatBrlDisplay } from '@observability/core/common/helpers/display/display.js';
import { StampedTokenCost } from '@observability/core/domain/models/trace-model.js';

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

    it('MUST return 400 for an unknown query parameter (C-3 strict — the endpoint takes none)', async () => {
      await request(app).get('/api/v1/bills?foo=1').expect(400);
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
      // Strict contract (C-3): an unknown param is a 400, never ignored.
      await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6&foo=1')
        .expect(400);
    });

    // Wave review: the future-month rejection is a DOMAIN error the
    // controllers re-wrap. Covered at controller level, but only real HTTP
    // proves what the client actually receives — the raw domain error
    // serialized to `{"name":"BillingPeriodStateError"}`: no `msg` at all,
    // and an internal class name on the wire. Pinned on BOTH resources.
    it('MUST return a 400 {name, msg} for a future month — never a bare domain error', async () => {
      for (const path of [
        '/api/v1/billing/summary?year=2099&month=1',
        '/api/v1/billing/statement?year=2099&month=1&format=csv',
        '/api/v1/billing/statement?year=2099&month=1&format=html',
      ]) {
        const response = await request(app).get(path).expect(400);

        expect(response.body).toEqual({
          name: 'InvalidParamError',
          msg: expect.stringContaining('está no futuro'),
        });
      }
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

      // Clock-safety of the period labels: the fixtures live in 2026-06
      // and no suite closes that month, so a PAST month with no lifecycle
      // doc labels 'open' (never 'in_progress', never 'closed') for ANY
      // future run date — the real clock only moves June further into the
      // past. That is what keeps these real-clock asserts deterministic.
      expect(response.body.period_status).toBe('open');
      expect(response.body.partial).toBe(false);
    });
  });

  describe('Demo step 7: register missing price → reprocess → totals grow', () => {
    // This is the ONE describe that mutates the pristine June state (price
    // registration + reprocess). The restore lives in afterAll — not in the
    // test body — so a mid-test failure can never poison the describes that
    // run after this one: declaration order is not load-bearing.
    afterAll(async () => {
      await routeDbHarness.ingestJuneFixtures();
    });

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
    });
  });

  describe('GET /api/v1/billing/series — month granularity (T8/US11)', () => {
    it('MUST serve the SAME June total the statement serves (series ↔ statement, one truth)', async () => {
      const seriesResponse = await request(app)
        .get('/api/v1/billing/series')
        .expect(200);
      const summaryResponse = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(seriesResponse.body.granularity).toBe('month');

      const juneBucket = seriesResponse.body.months.find(
        (bucket: { year: number; month: number }) =>
          bucket.year === 2026 && bucket.month === 6,
      );

      expect(juneBucket).toBeDefined();
      // Same store, same engine: the series' June bucket and the month
      // statement answer the EXACT same BRL display string (invariant 3).
      expect(juneBucket.total_cost_brl_display).toBe(
        summaryResponse.body.total_cost_brl_display,
      );
      // 2026-06 fixtures → 'open' is clock-safe for all future run dates
      // (see the note in the pending-price describe).
      expect(juneBucket.period_status).toBe('open');

      const totalSeries = seriesResponse.body.series.find(
        (series: { key: string }) => series.key === 'total',
      );
      const junePoint = totalSeries.points.find(
        (point: { year: number; month: number }) =>
          point.year === 2026 && point.month === 6,
      );

      expect(junePoint.cost_brl_display).toBe(
        summaryResponse.body.total_cost_brl_display,
      );

      expect(
        FORBIDDEN_INTERNAL_KEYS.test(JSON.stringify(seriesResponse.body)),
      ).toBe(false);
    });

    it('MUST return 400 for malformed, unknown or cross-granularity params (C-3 strict)', async () => {
      await request(app).get('/api/v1/billing/series?months=abc').expect(400);
      await request(app).get('/api/v1/billing/series?months=0').expect(400);
      await request(app).get('/api/v1/billing/series?months=25').expect(400);
      await request(app).get('/api/v1/billing/series?days=0').expect(400);
      await request(app).get('/api/v1/billing/series?days=91').expect(400);
      await request(app)
        .get('/api/v1/billing/series?granularity=week')
        .expect(400);
      await request(app).get('/api/v1/billing/series?foo=1').expect(400);

      // Cross-field rule: each window param belongs to ITS granularity —
      // silently ignoring the stray param would answer a different window
      // than the client asked for.
      await request(app)
        .get('/api/v1/billing/series?granularity=month&days=7')
        .expect(400);
      await request(app).get('/api/v1/billing/series?days=7').expect(400);
      await request(app)
        .get('/api/v1/billing/series?granularity=day&months=3')
        .expect(400);
    });
  });

  describe('GET /api/v1/billing/series — daily lens (decision 97)', () => {
    // The pinned clock must never leak into other tests.
    afterEach(() => {
      jest.useRealTimers();
    });

    it('MUST make the June day buckets equal the raw per-day sums — and Σ days ≡ the month total', async () => {
      // The daily window is anchored on "today", so June 2026 would drift
      // out of the 90-day horizon on a future run date. Pin ONLY Date to
      // June 30th (timers stay real — supertest and the mongo driver keep
      // working) and days=30 becomes exactly June, deterministically.
      jest.useFakeTimers({
        now: new Date('2026-06-30T12:00:00.000Z'),
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });

      const response = await request(app)
        .get('/api/v1/billing/series?granularity=day&days=30')
        .expect(200);

      jest.useRealTimers();

      expect(response.body.granularity).toBe('day');
      expect(response.body.months).toEqual([]);

      const totalSeries = response.body.series.find(
        (series: { key: string }) => series.key === 'total',
      );

      expect(totalSeries.points).toHaveLength(30);

      // Independent recomputation: per-UTC-day µ¢ sums in plain JS over
      // the raw stored traces — never the aggregation pipeline.
      const traces = await juneTracesFromDb();
      const stamped = traces.filter(
        (trace) => trace.pricingStatus === 'stamped',
      );
      const dayMicrocents = new Array(31).fill(0) as number[];

      for (const trace of stamped) {
        dayMicrocents[new Date(trace.startedAt).getUTCDate()] +=
          trace.totalCostMicrocents ?? 0;
      }

      totalSeries.points.forEach(
        (
          point: {
            year: number;
            month: number;
            day?: number;
            partial: boolean;
            cost_brl_display: string;
          },
          index: number,
        ) => {
          expect({
            year: point.year,
            month: point.month,
            day: point.day,
          }).toEqual({ year: 2026, month: 6, day: index + 1 });
          // Every bucket — including the zero-filled gap days — carries
          // the display of ITS raw per-day sum, nothing reshuffled.
          expect(point.cost_brl_display).toBe(
            formatBrlDisplay(
              formatBrlFromMicrocents(dayMicrocents[index + 1] as number),
            ),
          );
          // Only "today" (June 30 under the pinned clock) is partial.
          expect(point.partial).toBe(index === 29);
        },
      );

      // Σ day buckets ≡ month total ≡ the statement, over the SAME store
      // (invariant 3): the per-day sums verified above add up to the very
      // total the summary serves.
      const monthMicrocents = stamped.reduce(
        (sum, trace) => sum + (trace.totalCostMicrocents ?? 0),
        0,
      );

      expect(dayMicrocents.reduce((sum, cost) => sum + cost, 0)).toBe(
        monthMicrocents,
      );

      const summaryResponse = await request(app)
        .get('/api/v1/billing/summary?year=2026&month=6')
        .expect(200);

      expect(summaryResponse.body.total_cost_brl).toBe(
        formatBrlFromMicrocents(monthMicrocents),
      );
    });
  });

  describe('GET /api/v1/billing/projection (US12/T8)', () => {
    it('MUST answer the current-month estimate, labeled, in one of its two honest shapes', async () => {
      const response = await request(app)
        .get('/api/v1/billing/projection')
        .expect(200);

      // Always an estimate, never a bill (US12).
      expect(response.body.is_estimate).toBe(true);
      expect(typeof response.body.insufficient_data).toBe('boolean');
      expect(typeof response.body.accrued_cost_brl_display).toBe('string');
      expect(typeof response.body.basis_text).toBe('string');

      // Whichever shape the real clock yields, it must be coherent:
      // insufficient data ⇒ no projected number; enough data ⇒ one.
      if (response.body.insufficient_data) {
        expect(response.body.projected_cost_brl_display).toBeNull();
      } else {
        expect(typeof response.body.projected_cost_brl_display).toBe(
          'string',
        );
      }

      expect(
        FORBIDDEN_INTERNAL_KEYS.test(JSON.stringify(response.body)),
      ).toBe(false);
    });

    it('MUST return 400 for ANY query parameter (C-3 — the endpoint takes none)', async () => {
      await request(app).get('/api/v1/billing/projection?year=2026').expect(400);
      await request(app).get('/api/v1/billing/projection?foo=1').expect(400);
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
