import request from 'supertest';
import { server } from '../../app.js';
import { routeDbHarness } from './helpers/route-db-harness.js';

const app = server.app;

describe('Sessions Routes', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('GET /api/v1/sessions', () => {
    it('MUST group traces by session — traces without session stay out', async () => {
      const response = await request(app).get('/api/v1/sessions').expect(200);

      expect(response.body.total).toBe(4);
      expect(
        response.body.items.map((item: { session_id: string }) => item.session_id),
      ).toEqual([
        'sess-cobranca-004',
        'sess-suporte-003',
        'sess-cobranca-002',
        'sess-checkout-001',
      ]);
    });

    it('MUST aggregate a cross-window session: count, tokens, duration, cost = Σ traces', async () => {
      const response = await request(app).get('/api/v1/sessions').expect(200);

      const checkout = response.body.items.find(
        (item: { session_id: string }) =>
          item.session_id === 'sess-checkout-001',
      );

      expect(checkout.trace_count).toBe(4);
      expect(checkout.status).toBe('ok');
      expect(checkout.tokens_in).toBe(6000);
      expect(checkout.tokens_out).toBe(1400);
      expect(checkout.total_duration_ms).toBe(4000 + 7000 + 2000 + 5000);
      // 715_000 + 1_232_000 + 412_500 + 1_160_375 µ¢ = 3_519_875 µ¢ → R$ 0.04
      expect(checkout.cost_brl).toBe('0.04');
      expect(checkout.pending_price_count).toBe(0);
      expect(checkout.started_at).toBe('2026-06-05T14:00:00.000Z');
      expect(checkout.last_activity_at).toBe('2026-06-16T10:00:05.000Z');
    });

    it('MUST mark a session with any failed trace as error', async () => {
      const response = await request(app)
        .get('/api/v1/sessions?status=error')
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].session_id).toBe('sess-cobranca-002');
    });

    it('MUST NEVER show a pending session as R$ 0 — cost_brl null + count exposed', async () => {
      const response = await request(app).get('/api/v1/sessions').expect(200);

      const pendingSession = response.body.items.find(
        (item: { session_id: string }) => item.session_id === 'sess-suporte-003',
      );

      expect(pendingSession.pending_price_count).toBe(2);
      expect(pendingSession.cost_brl).toBeNull();
      expect(pendingSession.stamped_cost_brl_partial).toBe('0.00');
    });

    it('MUST filter the period by session START time (QA17)', async () => {
      // sess-checkout-001 and sess-suporte-003 both have June ≥15 traces but
      // STARTED before June 15 — the start time keeps them out of this period.
      const response = await request(app)
        .get('/api/v1/sessions?from=2026-06-15T00:00:00.000Z')
        .expect(200);

      expect(
        response.body.items.map((item: { session_id: string }) => item.session_id),
      ).toEqual(['sess-cobranca-004']);
    });

    it('MUST filter by agent', async () => {
      const response = await request(app)
        .get('/api/v1/sessions?agent=agent-atendimento')
        .expect(200);

      expect(response.body.total).toBe(1);
      expect(response.body.items[0].session_id).toBe('sess-checkout-001');
    });
  });

  describe('GET /api/v1/sessions/filters', () => {
    it('MUST count SESSIONS per option over the read-model (decision 80)', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/filters')
        .expect(200);

      // June fixtures: 4 sessions, 1 with a failed trace (cobranca-002).
      expect(response.body.statuses).toEqual(
        expect.arrayContaining([
          { value: 'ok', count: 3 },
          { value: 'error', count: 1 },
        ]),
      );
      expect(response.body.statuses).toHaveLength(2);

      // agent-atendimento owns exactly one session (checkout-001).
      expect(response.body.agents).toEqual(
        expect.arrayContaining([{ value: 'agent-atendimento', count: 1 }]),
      );

      const totalAgentCount = response.body.agents.reduce(
        (sum: number, option: { count: number }) => sum + option.count,
        0,
      );

      expect(totalAgentCount).toBeLessThanOrEqual(4);
    });

    it('MUST cascade with self-exclusion (decision 76): agent options honor the status filter, status options keep listing alternatives', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/filters?status=error')
        .expect(200);

      // Agent counts now cover ONLY the single error session…
      const totalAgentCount = response.body.agents.reduce(
        (sum: number, option: { count: number }) => sum + option.count,
        0,
      );

      expect(totalAgentCount).toBe(1);

      // …while the status field self-excludes its own filter: both
      // alternatives stay listed with their unfiltered counts.
      expect(response.body.statuses).toEqual(
        expect.arrayContaining([
          { value: 'ok', count: 3 },
          { value: 'error', count: 1 },
        ]),
      );
    });

    it('MUST reject an unknown param (strict schema)', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/filters?agents=x')
        .expect(400);

      expect(response.body.name).toBe('InvalidParamError');
    });
  });

  describe('GET /api/v1/sessions/:id', () => {
    it('MUST return the chronological chain — shuffled arrivals reorder naturally', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/sess-checkout-001')
        .expect(200);

      expect(
        response.body.chain.map((entry: { trace_id: string }) => entry.trace_id),
      ).toEqual(['trace-w1-001', 'trace-w1-002', 'trace-w1-003', 'trace-w2-001']);
    });

    it('MUST read as a transcript: content + per-step cost in the chain', async () => {
      const response = await request(app)
        .get('/api/v1/sessions/sess-checkout-001')
        .expect(200);

      const firstStep = response.body.chain[0];

      expect(firstStep.input).toContain('tênis');
      expect(firstStep.output).toContain('troca');
      expect(firstStep.cost_brl).toBe('0.01');
      expect(response.body.cost_brl).toBe('0.04');
    });

    it('MUST return 404 for an unknown session', async () => {
      await request(app).get('/api/v1/sessions/nao-existe').expect(404);
    });
  });
});
