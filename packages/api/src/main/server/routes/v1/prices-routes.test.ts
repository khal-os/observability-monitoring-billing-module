/**
 * Prices integration (T4 write path): registering a version over HTTP runs
 * the SAME single path as the runbook job — canonical model key (decision
 * 82) + immediate reprocess of what the new price unblocks (decision 57,
 * US3) — against the real store.
 */
import request from 'supertest';
import { server } from '../../app.js';
import { routeDbHarness } from './helpers/route-db-harness.js';

const app = server.app;

const FORBIDDEN_INTERNAL_KEYS =
  /marketPriceUsd|ptaxReference|markupPercent|Microcents|microcents|"_id"/;

const validBody = () => ({
  model: 'meta/llama-4-scout',
  token_type: 'input' as const,
  price_brl_per_million: '1.00',
  effective_from: '2026-06-01',
});

const juneSummary = async () =>
  (await request(app).get('/api/v1/billing/summary?year=2026&month=6')).body;

describe('Prices Routes', () => {
  beforeAll(async () => {
    await routeDbHarness.connect();
    await routeDbHarness.ingestJuneFixtures();
  });

  afterAll(async () => {
    await routeDbHarness.disconnect();
  });

  describe('POST /api/v1/prices — validation', () => {
    it('MUST return 400 for missing, malformed or UNKNOWN fields', async () => {
      for (const field of [
        'model',
        'token_type',
        'price_brl_per_million',
        'effective_from',
      ]) {
        const body: Record<string, unknown> = { ...validBody() };

        delete body[field];

        await request(app).post('/api/v1/prices').send(body).expect(400);
      }

      // Money is a decimal STRING, never a JSON float.
      await request(app)
        .post('/api/v1/prices')
        .send({ ...validBody(), price_brl_per_million: 1.0 })
        .expect(400);

      // Strict contract: a typoed key must fail loudly, not be ignored.
      await request(app)
        .post('/api/v1/prices')
        .send({ ...validBody(), efective_from: '2026-06-01' })
        .expect(400);
    });
  });

  describe('POST /api/v1/prices — US3: the missing price unblocks pending traces', () => {
    it('MUST register (canonicalizing a bare id), stamp what it unblocks and update billing', async () => {
      const before = await juneSummary();

      expect(before.pending_price.trace_count).toBeGreaterThan(0);
      expect(before.pending_price.models).toContain('meta/llama-4-scout');

      // BARE id on purpose: the endpoint must canonicalize to the same
      // provider/id key the stamper looks up (decision 82).
      const inputResponse = await request(app)
        .post('/api/v1/prices')
        .send({ ...validBody(), model: 'llama-4-scout' })
        .expect(201);

      expect(inputResponse.body.model).toBe('meta/llama-4-scout');
      expect(inputResponse.body.price_brl_per_million).toBe('1.00');
      expect(inputResponse.body.price_display).toBe('R$ 1,00/M');
      expect(inputResponse.body.effective_from_display).toBe('01/06/2026');
      // Decision 57 ran: every pending trace was examined right away.
      expect(inputResponse.body.reprocess.examined).toBe(
        before.pending_price.trace_count,
      );

      const outputResponse = await request(app)
        .post('/api/v1/prices')
        .send({
          ...validBody(),
          token_type: 'output',
          price_brl_per_million: '4.00',
        })
        .expect(201);

      // With BOTH token prices in place the pending llama traces stamp —
      // never partially (invariant 2): whatever stamped did so whole.
      const stampedTotal =
        inputResponse.body.reprocess.stamped +
        outputResponse.body.reprocess.stamped;

      expect(stampedTotal).toBeGreaterThan(0);

      const after = await juneSummary();

      expect(after.pending_price.trace_count).toBe(
        before.pending_price.trace_count - stampedTotal,
      );
      expect(after.pending_price.models).not.toContain('meta/llama-4-scout');
      expect(
        after.lines.some(
          (line: { model: string | null }) =>
            line.model === 'meta/llama-4-scout',
        ),
      ).toBe(true);

      // R$ only (invariant 4) — the write endpoint leaks no internal keys.
      expect(
        FORBIDDEN_INTERNAL_KEYS.test(JSON.stringify(inputResponse.body)),
      ).toBe(false);
      expect(
        FORBIDDEN_INTERNAL_KEYS.test(JSON.stringify(outputResponse.body)),
      ).toBe(false);
    });

    it('MUST answer a duplicate (model, token_type, effective_from) with 409 (invariant 9)', async () => {
      // Same tuple as the canonicalized FIRST registration above — the
      // bare-id and canonical spellings are ONE identity.
      const response = await request(app)
        .post('/api/v1/prices')
        .send(validBody())
        .expect(409);

      expect(response.body.name).toBe('ConflictError');
      expect(response.body.msg).toContain('meta/llama-4-scout');
    });
  });
});
