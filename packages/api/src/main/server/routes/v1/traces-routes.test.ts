import request from 'supertest';
import { server } from '../../app.js';
import { routeDbHarness } from './helpers/route-db-harness.js';
import { makeFilterCounterRebuild } from '../../../factories/database-factory.js';

const app = server.app;

const FORBIDDEN_INTERNAL_KEYS =
  /marketPriceUsd|ptaxReference|markupPercent|Microcents|microcents|"_id"/;

describe('Traces Routes', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('GET /api/v1/traces', () => {
    it('MUST list every ingested trace, most recent first', async () => {
      const response = await request(app).get('/api/v1/traces').expect(200);

      expect(response.body.total).toBe(9);
      // Uncapped totals read exact — no "+" (decision 77).
      expect(response.body.total_capped).toBe(false);
      expect(response.body.total_display).toBe('9');
      expect(response.body.total_pages_display).toBe('1');
      expect(response.body.items[0].trace_id).toBe('trace-w2-003');
      expect(response.body.items.at(-1).trace_id).toBe('trace-w1-001');
    });

    it('MUST expose the pending_price trace with cost_brl null — never R$ 0.00', async () => {
      const response = await request(app).get('/api/v1/traces').expect(200);

      const pending = response.body.items.find(
        (item: { trace_id: string }) => item.trace_id === 'trace-w1-006',
      );

      expect(pending.pricing_status).toBe('pending_price');
      expect(pending.cost_brl).toBeNull();
      expect(pending.tokens_in).toBe(5000);
    });

    it('MUST filter by agent, status, period and free search by session id', async () => {
      const byAgent = await request(app)
        .get('/api/v1/traces?agent=agent-atendimento')
        .expect(200);
      expect(byAgent.body.total).toBe(5);

      const byStatus = await request(app)
        .get('/api/v1/traces?status=error')
        .expect(200);
      expect(byStatus.body.total).toBe(1);
      expect(byStatus.body.items[0].trace_id).toBe('trace-w1-005');
      expect(byStatus.body.items[0].cost_brl).toBe('0.08');

      const byPeriod = await request(app)
        .get('/api/v1/traces?from=2026-06-15T00:00:00.000Z')
        .expect(200);
      expect(byPeriod.body.total).toBe(3);

      const bySearch = await request(app)
        .get('/api/v1/traces?search=sess-checkout-001')
        .expect(200);
      expect(bySearch.body.total).toBe(4);

      const byChannel = await request(app)
        .get('/api/v1/traces?channel=web')
        .expect(200);
      expect(byChannel.body.total).toBe(3);
    });

    it('MUST OR repeated values of one param and AND across params (decision 76)', async () => {
      const byDomains = await request(app)
        .get('/api/v1/traces?domain=varejo&domain=suporte')
        .expect(200);
      expect(byDomains.body.total).toBe(7);

      const combined = await request(app)
        .get('/api/v1/traces?domain=varejo&domain=suporte&channel=web')
        .expect(200);
      expect(combined.body.total).toBe(3);

      const byAgents = await request(app)
        .get('/api/v1/traces?agent=agent-cobranca&agent=agent-suporte')
        .expect(200);
      expect(byAgents.body.total).toBe(4);
    });

    it('MUST paginate on the server', async () => {
      const response = await request(app)
        .get('/api/v1/traces?page=2&page_size=4')
        .expect(200);

      expect(response.body.total).toBe(9);
      expect(response.body.items).toHaveLength(4);
      expect(response.body.page).toBe(2);
    });

    it('MUST answer 400 (not 500) for invalid query params', async () => {
      await request(app).get('/api/v1/traces?from=banana').expect(400);
      await request(app).get('/api/v1/traces?page_size=9999').expect(400);
      await request(app).get('/api/v1/traces?agent=a&agent=').expect(400);
    });
  });

  describe('GET /api/v1/traces/filters', () => {
    it('MUST list the stored values per filterable field with trace counts', async () => {
      const response = await request(app)
        .get('/api/v1/traces/filters')
        .expect(200);

      expect(response.body).toEqual({
        domains: [
          { value: 'financeiro', count: 2 },
          { value: 'suporte', count: 2 },
          { value: 'varejo', count: 5 },
        ],
        subdomains: [
          { value: 'cobranca', count: 2 },
          { value: 'loja-sp', count: 4 },
        ],
        types: [{ value: 'chat', count: 9 }],
        agents: [
          { value: 'agent-atendimento', count: 5 },
          { value: 'agent-cobranca', count: 2 },
          { value: 'agent-suporte', count: 2 },
        ],
        channels: [
          { value: 'web', count: 3 },
          { value: 'whatsapp', count: 6 },
        ],
        statuses: [
          { value: 'error', count: 1 },
          { value: 'ok', count: 8 },
        ],
      });
    });

    it('MUST cascade with self-exclusion: a selected field keeps its alternatives', async () => {
      const response = await request(app)
        .get('/api/v1/traces/filters?domain=varejo')
        .expect(200);

      // Every other field narrows to the 5 varejo traces ("what-if" counts)...
      expect(response.body.subdomains).toEqual([
        { value: 'loja-sp', count: 4 },
      ]);
      expect(response.body.agents).toEqual([
        { value: 'agent-atendimento', count: 5 },
      ]);
      expect(response.body.channels).toEqual([
        { value: 'web', count: 1 },
        { value: 'whatsapp', count: 4 },
      ]);
      expect(response.body.statuses).toEqual([{ value: 'ok', count: 5 }]);
      // ...while the domain dropdown itself still lists the alternatives.
      expect(response.body.domains).toEqual([
        { value: 'financeiro', count: 2 },
        { value: 'suporte', count: 2 },
        { value: 'varejo', count: 5 },
      ]);
    });

    it('MUST self-exclude status too — the status dropdown never collapses', async () => {
      const response = await request(app)
        .get('/api/v1/traces/filters?status=error')
        .expect(200);

      // The only error trace is trace-w1-005 (agent-cobranca, financeiro).
      expect(response.body).toEqual({
        domains: [{ value: 'financeiro', count: 1 }],
        subdomains: [{ value: 'cobranca', count: 1 }],
        types: [{ value: 'chat', count: 1 }],
        agents: [{ value: 'agent-cobranca', count: 1 }],
        channels: [{ value: 'whatsapp', count: 1 }],
        // Self-excluded: both statuses stay visible with full counts.
        statuses: [
          { value: 'error', count: 1 },
          { value: 'ok', count: 8 },
        ],
      });
    });

    it('MUST answer 400 (not 500) for invalid query params', async () => {
      await request(app).get('/api/v1/traces/filters?from=banana').expect(400);
      await request(app)
        .get('/api/v1/traces/filters?status=pending')
        .expect(400);
    });

    it('MUST serve identical facets after a cube rebuild (ground truth, decision 77)', async () => {
      const incremental = await request(app)
        .get('/api/v1/traces/filters?domain=varejo')
        .expect(200);

      await makeFilterCounterRebuild().run();

      const rebuilt = await request(app)
        .get('/api/v1/traces/filters?domain=varejo')
        .expect(200);

      expect(rebuilt.body).toEqual(incremental.body);
    });

    it('MUST fall back to the live path for search (not a cube dimension)', async () => {
      const response = await request(app)
        .get('/api/v1/traces/filters?search=sess-checkout-001')
        .expect(200);

      // The session has 4 traces — every facet is scoped to them.
      const totalOf = (options: { count: number }[]) =>
        options.reduce((sum, option) => sum + option.count, 0);

      expect(totalOf(response.body.statuses)).toBe(4);
      expect(response.body.agents).toHaveLength(1);
    });
  });

  describe('GET /api/v1/traces/:id', () => {
    it('MUST return the full anatomy: metrics, ordered spans, content, session link', async () => {
      const response = await request(app)
        .get('/api/v1/traces/trace-w1-005')
        .expect(200);

      expect(response.body.status).toBe('error');
      expect(response.body.session_id).toBe('sess-cobranca-002');
      expect(response.body.model).toBe('anthropic/claude-sonnet-5');

      expect(
        response.body.spans.map((span: { span_id: string }) => span.span_id),
      ).toEqual(['span-w1-005-1', 'span-w1-005-2']);
      expect(response.body.spans[1].status).toBe('error');
      expect(response.body.spans[1].error_message).toContain('Timeout');

      expect(response.body.content.input).toContain('duplicidade');

      expect(response.body.costs).toEqual([
        expect.objectContaining({
          token_type: 'input',
          tokens: 3000,
          applied_price_brl_per_million: '16.50',
          cost_brl_exact: '0.0495',
        }),
        expect.objectContaining({ token_type: 'output' }),
      ]);
      expect(response.body.cost_brl).toBe('0.08');
    });

    it('MUST expose which agent BUILD and omni deployment served the trace', async () => {
      const response = await request(app)
        .get('/api/v1/traces/trace-w1-001')
        .expect(200);

      expect(response.body.agent).toEqual({
        id: 'agent-atendimento',
        version: '1.4.2',
        instance: 'agent-atendimento-7d9f4b-k2xp8',
      });
      expect(response.body.domain).toBe('varejo');
      expect(response.body.subdomain).toBe('loja-sp');
      expect(response.body.channel).toEqual({
        type: 'whatsapp',
        version: '3.2.0',
        instance: 'omni-wa-6b4c9f-r3zs5',
      });
    });

    it('MUST show the agent release rollover between windows', async () => {
      const response = await request(app)
        .get('/api/v1/traces/trace-w2-001')
        .expect(200);

      expect(response.body.agent.version).toBe('1.5.0');
      expect(response.body.channel.version).toBe('3.3.1');
    });

    it('MUST be honest about a trace without session', async () => {
      const response = await request(app)
        .get('/api/v1/traces/trace-w1-004')
        .expect(200);

      expect(response.body.session_id).toBeNull();
    });

    it('MUST say WHICH token types lack a price on a pending trace', async () => {
      const response = await request(app)
        .get('/api/v1/traces/trace-w1-006')
        .expect(200);

      expect(response.body.pricing_status).toBe('pending_price');
      expect(response.body.cost_brl).toBeNull();
      expect(response.body.costs).toBeNull();
      expect(response.body.pending_missing_token_types).toEqual([
        'input',
        'output',
      ]);
    });

    it('MUST return 404 for an unknown trace', async () => {
      await request(app).get('/api/v1/traces/nao-existe').expect(404);
    });
  });

  describe('Projection schema (invariant 4)', () => {
    it('MUST NOT leak internal fields anywhere in the payloads', async () => {
      const list = await request(app).get('/api/v1/traces').expect(200);
      const detail = await request(app)
        .get('/api/v1/traces/trace-w1-001')
        .expect(200);
      const filters = await request(app)
        .get('/api/v1/traces/filters')
        .expect(200);

      expect(JSON.stringify(list.body)).not.toMatch(FORBIDDEN_INTERNAL_KEYS);
      expect(JSON.stringify(detail.body)).not.toMatch(FORBIDDEN_INTERNAL_KEYS);
      expect(JSON.stringify(filters.body)).not.toMatch(
        FORBIDDEN_INTERNAL_KEYS,
      );
    });
  });
});
