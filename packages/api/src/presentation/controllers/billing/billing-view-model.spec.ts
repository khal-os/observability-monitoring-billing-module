import { toBillingSummaryView } from './billing-view-model.js';
import { BillingSummary } from './billing-protocols.js';
import { buildStatement } from '../../../application/useCases/billingStatement/statement-engine.js';
import { usageRecord } from '../../../application/useCases/billingStatement/billing-test-fakes.js';

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
});
