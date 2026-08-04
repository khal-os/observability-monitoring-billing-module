import { toBillingSummaryView } from './billing-view-model.js';
import { BillingSummary } from './billing-protocols.js';
import { buildStatement } from '../../../application/useCases/billingStatement/statement-engine.js';
import { usageRecord } from '@observability/core/application/testSupport/billing-test-fakes.js';

/** "R$ 1.234,56" → integer cents, digits only — no float parsing. */
const centsOf = (display: string): number =>
  Number(display.replace(/[^\d]/g, ''));

const halfCentInput = (
  traceId: string,
  agentId: string,
  model: string,
): ReturnType<typeof usageRecord> =>
  usageRecord({
    traceId,
    agentId,
    agentVersion: null,
    model,
    stampedCosts: [
      {
        tokenType: 'input',
        tokens: 100,
        appliedPriceMicrocentsPerMillion: 5_000_000_000,
        appliedPriceEffectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
        costMicrocents: 500_000, // meio centavo — o pior caso de arredondamento
      },
    ],
    totalCostMicrocents: 500_000,
  });

const makeSummary = (): BillingSummary => ({
  year: 2026,
  month: 6,
  periodStatus: 'open',
  // Three agents × three models, half a cent each: independent rounding
  // would display 0,01 × 3 = 0,03 against a 0,02 total (regression that
  // shipped: agent donut said 331,87, model donut 331,88).
  statement: buildStatement([
    halfCentInput('t1', 'agent-a', 'model-x'),
    halfCentInput('t2', 'agent-b', 'model-y'),
    halfCentInput('t3', 'agent-c', 'model-z'),
  ]),
  pendingPrice: { traceCount: 0, tokens: {}, models: [] },
  ingestionWatermark: null,
  reopenNotes: [],
  quarantinedTraceCount: 0,
  noMeasuredUsageTraceCount: 0,
  comparison: null,
});

describe('toBillingSummaryView — every displayed breakdown closes with the displayed total (T5)', () => {
  it('agent mix, model mix and agent groups each sum EXACTLY to the total', () => {
    const view = toBillingSummaryView(makeSummary());
    const totalCents = centsOf(view.total_cost_brl_display);

    const agentMixCents = view.agent_mix.reduce(
      (sum, slice) => sum + centsOf(slice.cost_brl_display),
      0,
    );
    const modelMixCents = view.model_mix.total.reduce(
      (sum, share) => sum + centsOf(share.cost_brl_display),
      0,
    );
    const agentGroupCents = view.agents.reduce(
      (sum, group) => sum + centsOf(group.cost_brl_display),
      0,
    );

    expect(agentMixCents).toBe(totalCents);
    expect(modelMixCents).toBe(totalCents);
    expect(agentGroupCents).toBe(totalCents);
  });

  it('shares close at 100% in both donuts', () => {
    const view = toBillingSummaryView(makeSummary());

    const lastAgent = view.agent_mix[view.agent_mix.length - 1];
    const lastModel = view.model_mix.total[view.model_mix.total.length - 1];

    expect(lastAgent?.donut_end_percent).toBe(100);
    expect(lastModel?.donut_end_percent).toBe(100);
  });

  it('by-agent model cents come from the engine lines: each agent mix closes with its OWN card (B-9)', () => {
    // Two agents, one half-cent (500_000 µ¢) line each: the statement
    // reconciles 0,01 + 0,00 = 0,01. An independent per-agent
    // re-reconciliation would show 0,01 for BOTH agents' model mixes —
    // contradicting agent B's own card and summing to 0,02 ≠ 0,01.
    const summary = makeSummary();
    summary.statement = buildStatement([
      halfCentInput('t1', 'agent-a', 'model-x'),
      halfCentInput('t2', 'agent-b', 'model-y'),
    ]);

    const view = toBillingSummaryView(summary);
    const totalCents = centsOf(view.total_cost_brl_display);
    expect(totalCents).toBe(1);

    let allAgentModelCents = 0;

    for (const mix of view.model_mix.by_agent) {
      const card = view.agents.find(
        (group) => group.agent_label === mix.agent_label,
      );
      const mixCents = mix.models.reduce(
        (sum, share) => sum + centsOf(share.cost_brl_display),
        0,
      );

      // Per-agent closure: the agent's model breakdown equals its card.
      expect(card).toBeDefined();
      expect(mixCents).toBe(centsOf(card?.cost_brl_display ?? 'x'));
      allAgentModelCents += mixCents;
    }

    // Global closure: all by-agent model cents equal the statement total.
    expect(allAgentModelCents).toBe(totalCents);
  });

  it("a real agent literally named '(sem agente)' does NOT merge with unattributed traffic (donut keyed on id)", () => {
    const summary = makeSummary();
    summary.statement = buildStatement([
      usageRecord({ traceId: 't1', agentId: '(sem agente)' }),
      usageRecord({ traceId: 't2', agentId: null, agentVersion: null }),
    ]);

    const view = toBillingSummaryView(summary);

    // Two slices with the same rendered label — merged by id, never by label.
    expect(view.agent_mix).toHaveLength(2);
    expect(
      view.agent_mix.map((slice) => slice.agent_label),
    ).toEqual(['(sem agente)', '(sem agente)']);

    // Still closes: slices sum to the total, donut ends at 100%.
    const totalCents = centsOf(view.total_cost_brl_display);
    const sliceCents = view.agent_mix.reduce(
      (sum, slice) => sum + centsOf(slice.cost_brl_display),
      0,
    );
    expect(sliceCents).toBe(totalCents);
    expect(view.agent_mix[view.agent_mix.length - 1]?.donut_end_percent).toBe(
      100,
    );
  });
});
