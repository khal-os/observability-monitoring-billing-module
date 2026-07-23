import { TraceRepository } from './trace-repository.js';
import {
  StampedTokenCost,
  TraceModel,
} from '../../domain/models/trace-model.js';

/**
 * ADAPTER-AGNOSTIC contract suite for TraceRepository — the executable
 * specification of the invariants every storage backend must uphold:
 * idempotent ingestion (invariant: re-sync never double-counts), stamp
 * immutability (invariants 1/7), pending-never-R$0 (invariant 2) and the
 * merged-document unclassified recompute. The Mongo adapter runs it today;
 * any future adapter (Postgres, ...) runs the SAME suite with its own
 * harness — the invariant proofs are written once, against the port.
 *
 * Harness notes:
 * - readTrace returns the adapter's stored record using MODEL field names;
 *   how absence is stored (null vs missing) is the adapter's business —
 *   assertions here normalize with `?? null`.
 * - applyRawCorrection simulates the open-period runbook correction done
 *   directly in the store (sets agent {id}, removes the unclassified flag)
 *   so the "never re-flag a stored correction" rule is provable.
 */
export interface TraceRepositoryHarness {
  repository: TraceRepository;
  readTrace(traceId: string): Promise<Record<string, unknown> | null>;
  applyRawCorrection(traceId: string, agentId: string): Promise<void>;
  reset(): Promise<void>;
}

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

export const makeContractStampedCosts = (): StampedTokenCost[] => [
  {
    tokenType: 'input',
    tokens: 1200,
    appliedPriceMicrocentsPerMillion: 275_000_000,
    appliedPriceEffectiveFrom: JUNE_1,
    costMicrocents: 330_000,
  },
];

export const makeContractTrace = (
  overrides: Partial<TraceModel> = {},
): TraceModel => {
  const traceId = overrides.traceId ?? 'trace-001';

  return {
    traceId,
    sessionId: 'sess-001',
    agent: { id: 'agent-atendimento', version: '1.4.2', instance: 'agent-atendimento-7d9f4b-k2xp8' },
    model: 'openai/gpt-5-mini',
    type: 'chat',
    channel: { type: 'whatsapp', version: '3.2.0', instance: 'omni-wa-6b4c9f-r3zs5' },
    domain: 'varejo',
    startedAt: new Date('2026-06-05T14:00:00.000Z'),
    finishedAt: new Date('2026-06-05T14:00:04.000Z'),
    durationMs: 4000,
    status: 'ok',
    tokens: { input: 1200 },
    tokensTotal: 1200,
    pricingStatus: 'stamped',
    stampedCosts: makeContractStampedCosts(),
    totalCostMicrocents: 330_000,
    stampedAt: new Date('2026-07-01T00:00:00.000Z'),
    ingestedAt: new Date('2026-07-01T00:00:00.000Z'),
    input: 'entrada',
    output: 'saída',
    spans: [
      {
        spanId: `span-${traceId}`,
        type: 'llm',
        name: 'openai/gpt-5-mini',
        startedAt: new Date('2026-06-05T14:00:00.100Z'),
        finishedAt: new Date('2026-06-05T14:00:03.900Z'),
        durationMs: 3800,
        offsetMs: 100,
        status: 'ok',
        tokens: { input: 1200 },
      },
    ],
    ...overrides,
  };
};

const makePending = (overrides: Partial<TraceModel> = {}): TraceModel =>
  makeContractTrace({
    pricingStatus: 'pending_price',
    stampedCosts: undefined,
    totalCostMicrocents: undefined,
    stampedAt: undefined,
    ...overrides,
  });

type AgentRecord =
  | { id?: string; version?: string | null; instance?: string | null }
  | null
  | undefined;

export const runTraceRepositoryContract = (
  makeHarness: () => TraceRepositoryHarness,
): void => {
  describe('TraceRepository contract', () => {
    let harness: TraceRepositoryHarness;

    beforeEach(async () => {
      harness = makeHarness();
      await harness.reset();
    });

    describe('insertIfAbsent()', () => {
      it('MUST persist the SELF-CONTAINED trace on first ingestion', async () => {
        const result = await harness.repository.insertIfAbsent(
          makeContractTrace(),
        );

        expect(result).toBe('inserted');

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['input']).toBe('entrada');
        expect(stored?.['spans']).toHaveLength(1);
        expect(
          (stored?.['spans'] as { spanId: string }[])[0]?.spanId,
        ).toBe('span-trace-001');
      });

      it('MUST skip an already-ingested trace and change NOTHING (idempotency)', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());

        const tampered = makeContractTrace({ totalCostMicrocents: 999_999 });
        const result = await harness.repository.insertIfAbsent(tampered);

        expect(result).toBe('skipped');

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['spans']).toHaveLength(1); // spans untouched too
      });

      it('MUST store pending_price traces with the cost OPEN — never R$ 0 (invariant 2)', async () => {
        await harness.repository.insertIfAbsent(
          makePending({ traceId: 'trace-pending', model: 'meta/llama-4-scout' }),
        );

        const stored = await harness.readTrace('trace-pending');

        expect(stored?.['pricingStatus']).toBe('pending_price');
        expect(stored?.['totalCostMicrocents'] ?? null).toBeNull();
        expect(stored?.['stampedCosts'] ?? null).toBeNull();
        expect(stored?.['tokens']).toEqual({ input: 1200 });
      });
    });

    describe('updateAttribution()', () => {
      it('MUST update attribution fields and NEVER touch the stamp (invariant 7)', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());

        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-corrigido', version: '9.9.9' },
          domain: 'varejo-corrigido',
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        // The agent is replaced as a WHOLE canonical block: the previously
        // stored instance must NOT survive the correction.
        expect(agent?.id).toBe('agent-corrigido');
        expect(agent?.version ?? null).toBe('9.9.9');
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['domain']).toBe('varejo-corrigido');
        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['stampedCosts']).toHaveLength(1);
      });

      it('MUST clear the unclassified flag once attribution is complete', async () => {
        await harness.repository.insertIfAbsent(
          makeContractTrace({
            agent: undefined,
            unclassified: { reasons: ['missing agentId'] },
          }),
        );

        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-atendimento' },
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        expect(agent?.id).toBe('agent-atendimento');
        expect(agent?.version ?? null).toBeNull();
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['unclassified'] ?? null).toBeNull();
      });

      it('MUST NOT clear a missing-model flag while the stored model is still absent', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            model: undefined,
            unclassified: { reasons: ['missing model'] },
          }),
        );

        // Fresh payload fixes the agent but STILL lacks the model.
        await harness.repository.updateAttribution('trace-001', {
          agent: { id: 'agent-novo' },
        });

        const stored = await harness.readTrace('trace-001');
        const agent = stored?.['agent'] as AgentRecord;

        expect(agent?.id).toBe('agent-novo');
        expect(agent?.version ?? null).toBeNull();
        expect(agent?.instance ?? null).toBeNull();
        expect(stored?.['unclassified']).toEqual({ reasons: ['missing model'] });
      });

      it('MUST NOT re-flag attribution corrected in the store when the payload lacks it', async () => {
        await harness.repository.insertIfAbsent(
          makeContractTrace({
            agent: undefined,
            unclassified: { reasons: ['missing agentId'] },
          }),
        );

        // Open-period correction applied directly to the store (invariant 7)
        await harness.applyRawCorrection('trace-001', 'agent-corrigido');

        // Re-sync arrives with a payload that STILL lacks agentId
        await harness.repository.updateAttribution('trace-001', {});

        const stored = await harness.readTrace('trace-001');

        expect((stored?.['agent'] as AgentRecord)?.id).toBe('agent-corrigido');
        expect(stored?.['unclassified'] ?? null).toBeNull();
      });

      it('MUST persist a late-arriving model so reprocessing can stamp the trace', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            model: undefined,
            unclassified: { reasons: ['missing model'] },
          }),
        );

        await harness.repository.updateAttribution('trace-001', {
          model: 'openai/gpt-5-mini',
        });

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['model']).toBe('openai/gpt-5-mini');
        expect(stored?.['unclassified'] ?? null).toBeNull();
        expect(stored?.['pricingStatus']).toBe('pending_price');
      });
    });

    describe('stampPendingTrace()', () => {
      it('MUST stamp a pending trace exactly once — a stamped trace is immutable (invariant 1)', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending',
            pendingPrice: { missingTokenTypes: ['input'] },
          }),
        );

        const first = await harness.repository.stampPendingTrace(
          'trace-pending',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 330_000,
            stampedAt: new Date('2026-07-02T00:00:00.000Z'),
          },
        );

        expect(first).toBe('stamped');

        const second = await harness.repository.stampPendingTrace(
          'trace-pending',
          {
            stampedCosts: makeContractStampedCosts(),
            totalCostMicrocents: 999_999,
            stampedAt: new Date('2026-07-03T00:00:00.000Z'),
          },
        );

        expect(second).toBe('skipped');

        const stored = await harness.readTrace('trace-pending');

        expect(stored?.['totalCostMicrocents']).toBe(330_000);
        expect(stored?.['pendingPrice'] ?? null).toBeNull();
      });
    });

    describe('updatePendingPriceInfo()', () => {
      it('MUST refresh the missing-types list of a STILL-pending trace', async () => {
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending',
            pendingPrice: { missingTokenTypes: ['input', 'output'] },
          }),
        );

        await harness.repository.updatePendingPriceInfo('trace-pending', [
          'output',
        ]);

        const stored = await harness.readTrace('trace-pending');

        expect(stored?.['pricingStatus']).toBe('pending_price');
        expect(stored?.['pendingPrice']).toEqual({
          missingTokenTypes: ['output'],
        });
      });

      it('MUST NOT resurrect pendingPrice on a stamped trace (invariant 1)', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());

        await harness.repository.updatePendingPriceInfo('trace-001', [
          'input',
        ]);

        const stored = await harness.readTrace('trace-001');

        expect(stored?.['pricingStatus']).toBe('stamped');
        expect(stored?.['pendingPrice'] ?? null).toBeNull();
      });
    });

    describe('findPendingPrice()', () => {
      it('MUST return only pending traces, oldest first', async () => {
        await harness.repository.insertIfAbsent(makeContractTrace());
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending-2',
            startedAt: new Date('2026-06-10T00:00:00.000Z'),
          }),
        );
        await harness.repository.insertIfAbsent(
          makePending({
            traceId: 'trace-pending-1',
            startedAt: new Date('2026-06-08T00:00:00.000Z'),
          }),
        );

        const pending = await harness.repository.findPendingPrice();

        expect(pending.map((trace) => trace.traceId)).toEqual([
          'trace-pending-1',
          'trace-pending-2',
        ]);
      });
    });
  });
};
