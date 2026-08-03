import { ReprocessPendingDbUseCase } from './reprocess-pending-db-use-case.js';
import {
  EffectivePrices,
  PendingPriceTrace,
  PendingStamp,
  PriceVersionRepository,
  TraceRepository,
} from './reprocess-pending-protocols.js';
import { TraceAttribution } from '../../interfaces/trace-repository.js';
import { ModelRef } from '../../../domain/models/model-ref.js';
import { InMemoryBillingPeriodRepository } from '../../testSupport/billing-test-fakes.js';

/**
 * audit M2: the reprocess sweep finally gets its own spec — the closed-
 * month guard, the per-trace failure isolation (decision 79g), the
 * concurrent-skipped accounting and the B-5 model pin were all previously
 * asserted only incidentally (or only at zero).
 */

const JUNE_1 = new Date('2026-06-01T00:00:00.000Z');

const GPT: ModelRef = { id: 'gpt-5-mini', provider: 'openai' };

const pendingTrace = (
  overrides: Partial<PendingPriceTrace> & { traceId: string },
): PendingPriceTrace => ({
  model: GPT,
  startedAt: new Date('2026-07-05T12:00:00.000Z'),
  tokens: { input: 1000 },
  ...overrides,
});

class PriceVersionRepositoryStub implements PriceVersionRepository {
  /** Models with a registered input price; others resolve to {} (pending). */
  pricedModels = new Set<string>(['openai/gpt-5-mini']);
  failOnModel: string | null = null;
  readonly lookups: { model: string; atDate: Date }[] = [];

  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    this.lookups.push({ model, atDate });

    if (model === this.failOnModel) {
      throw new Error(`price table unreachable for ${model}`);
    }

    if (!this.pricedModels.has(model)) return {};

    return {
      input: {
        model,
        tokenType: 'input',
        pricingType: 'fixed_brl',
        priceMicrocentsPerMillion: 275_000_000,
        effectiveFrom: JUNE_1,
      },
    };
  }

  async insertVersion(): Promise<void> {}
}

class TraceRepositoryStub implements TraceRepository {
  pending: PendingPriceTrace[] = [];
  stampResult: 'stamped' | 'skipped' = 'stamped';
  readonly stamps: {
    traceId: string;
    stamp: PendingStamp;
    pinnedModel: ModelRef | null;
  }[] = [];

  async findPendingPrice(): Promise<PendingPriceTrace[]> {
    return this.pending;
  }

  async stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
    pinnedModel: ModelRef | null,
  ): Promise<'stamped' | 'skipped'> {
    this.stamps.push({ traceId, stamp, pinnedModel });

    return this.stampResult;
  }

  async insertIfAbsent(): Promise<'inserted'> {
    return 'inserted';
  }

  async updateAttribution(
    _traceId: string,
    _attribution: TraceAttribution,
  ): Promise<void> {}

  async reconcileQuarantineAfterClose(): Promise<{
    flaggedStragglers: number;
    absorbed: number;
  }> {
    return { flaggedStragglers: 0, absorbed: 0 };
  }
}

const makeSut = () => {
  const priceVersionRepository = new PriceVersionRepositoryStub();
  const traceRepository = new TraceRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();

  const sut = new ReprocessPendingDbUseCase({
    priceVersionRepository,
    traceRepository,
    billingPeriodRepository,
  });

  return { sut, priceVersionRepository, traceRepository, billingPeriodRepository };
};

const closeMonth = (
  billingPeriodRepository: InMemoryBillingPeriodRepository,
  year: number,
  month: number,
) =>
  billingPeriodRepository.markClosed({
    year,
    month,
    closedAt: new Date('2026-07-01T03:00:00.000Z'),
    snapshotVersion: 1,
    audit: {
      at: new Date('2026-07-01T03:00:00.000Z'),
      action: 'close',
      trigger: 'runbook',
      snapshotVersion: 1,
    },
  });

describe('ReprocessPendingDbUseCase', () => {
  it('T6 guard: a pending trace inside a CLOSED month is counted, never stamped', async () => {
    const { sut, traceRepository, billingPeriodRepository } = makeSut();
    await closeMonth(billingPeriodRepository, 2026, 6);

    traceRepository.pending = [
      pendingTrace({
        traceId: 'closed-june',
        startedAt: new Date('2026-06-10T00:00:00.000Z'),
      }),
      pendingTrace({ traceId: 'open-july' }),
    ];

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 2,
      stamped: 1,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 1,
    });
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'open-july',
    ]);
  });

  it('QA19: resolves prices as-of the TRACE date, per trace', async () => {
    const { sut, priceVersionRepository, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({
        traceId: 't1',
        startedAt: new Date('2026-07-03T09:00:00.000Z'),
      }),
    ];

    await sut.reprocess();

    expect(priceVersionRepository.lookups).toEqual([
      { model: 'openai/gpt-5-mini', atDate: new Date('2026-07-03T09:00:00.000Z') },
    ]);
  });

  it('per-trace isolation (decision 79g): one throwing trace never loses the run', async () => {
    const { sut, priceVersionRepository, traceRepository } = makeSut();
    priceVersionRepository.pricedModels.add('meta/llama-4-scout');
    priceVersionRepository.failOnModel = 'anthropic/claude-haiku-4-5';

    traceRepository.pending = [
      pendingTrace({ traceId: 'ok-1' }),
      pendingTrace({
        traceId: 'poison',
        model: { id: 'claude-haiku-4-5', provider: 'anthropic' },
      }),
      pendingTrace({
        traceId: 'ok-2',
        model: { id: 'llama-4-scout', provider: 'meta' },
      }),
    ];

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 3,
      stamped: 2,
      stillPending: 0,
      failed: 1,
      blockedClosedMonth: 0,
    });
    expect(traceRepository.stamps.map((stamp) => stamp.traceId)).toEqual([
      'ok-1',
      'ok-2',
    ]);
  });

  it('a model still without price stays pending — never R$ 0 (invariant 2)', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [
      pendingTrace({
        traceId: 'no-price',
        model: { id: 'nova-2', provider: 'amazon' },
      }),
      // No model at all: nothing to look prices up for — stays pending.
      pendingTrace({ traceId: 'no-model', model: undefined }),
    ];

    const report = await sut.reprocess();

    expect(report.stillPending).toBe(2);
    expect(report.stamped).toBe(0);
    expect(traceRepository.stamps).toEqual([]);
  });

  it('concurrent-skipped counts as STAMPED: the trace IS stamped either way (or the model moved and the next sweep settles it)', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [pendingTrace({ traceId: 'raced' })];
    traceRepository.stampResult = 'skipped';

    const report = await sut.reprocess();

    expect(report).toEqual({
      examined: 1,
      stamped: 1,
      stillPending: 0,
      failed: 0,
      blockedClosedMonth: 0,
    });
  });

  it('audit B-5: passes the model the prices were resolved for as the CAS pin', async () => {
    const { sut, traceRepository } = makeSut();
    traceRepository.pending = [pendingTrace({ traceId: 'pin-me' })];

    await sut.reprocess();

    expect(traceRepository.stamps).toEqual([
      expect.objectContaining({
        traceId: 'pin-me',
        pinnedModel: GPT,
      }),
    ]);
    // The pin is the exact ref the price lookup used — never re-read, so
    // a concurrent correction makes the CAS miss instead of mis-stamping.
    expect(traceRepository.stamps[0]?.pinnedModel).toBe(
      traceRepository.pending[0]?.model,
    );
  });
});
