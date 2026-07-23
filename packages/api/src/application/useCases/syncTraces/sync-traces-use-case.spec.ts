import {
  EffectivePrices,
  TraceSourceClient,
  SourceTrace,
  PriceVersionRepository,
  SyncWindow,
  TraceAttribution,
  TraceRepository,
  PendingStamp,
} from './sync-traces-protocols.js';
import { PriceVersionModel, TokenType } from '../../../domain/models/price-version-model.js';
import { TraceModel } from '../../../domain/models/trace-model.js';
import { SyncTracesToDbUseCase } from './sync-traces-use-case.js';

const WINDOW = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-06-15T00:00:00.000Z'),
};

const makeTrace = (overrides: Partial<SourceTrace> = {}): SourceTrace => ({
  traceId: 'trace-001',
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento', version: '1.4.2', instance: 'agent-atendimento-7d9f4b-k2xp8' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp' },
  domain: 'varejo',
  startedAt: new Date('2026-06-05T14:00:00.000Z'),
  finishedAt: new Date('2026-06-05T14:00:04.000Z'),
  status: 'ok',
  tokens: { input: 1200, output: 350 },
  input: 'entrada',
  output: 'saída',
  spans: [],
  ...overrides,
});

class TraceSourceClientStub implements TraceSourceClient {
  traces: SourceTrace[] = [makeTrace()];

  async fetchTraces(window: SyncWindow): Promise<SourceTrace[]> {
    return this.traces;
  }
}

class PriceVersionRepositoryStub implements PriceVersionRepository {
  async findEffectivePrices(
    model: string,
    atDate: Date,
  ): Promise<EffectivePrices> {
    const price = (tokenType: TokenType): PriceVersionModel => ({
      model,
      tokenType,
      priceMicrocentsPerMillion: 275_000_000,
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
    });

    return { input: price('input'), output: price('output') };
  }

  async insertVersion(): Promise<void> {}
}

class TraceRepositoryStub implements TraceRepository {
  inserted: TraceModel[] = [];
  attributionUpdates: { traceId: string; attribution: TraceAttribution }[] = [];
  insertResult: 'inserted' | 'skipped' = 'inserted';

  async insertIfAbsent(trace: TraceModel): Promise<'inserted' | 'skipped'> {
    if (this.insertResult === 'inserted') {
      this.inserted.push(trace);
    }

    return this.insertResult;
  }

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<void> {
    this.attributionUpdates.push({ traceId, attribution });
  }

  async stampPendingTrace(
    traceId: string,
    stamp: PendingStamp,
  ): Promise<'stamped' | 'skipped'> {
    return 'skipped';
  }

  async findPendingPrice(): Promise<TraceModel[]> {
    return [];
  }
}

const makeSut = () => {
  const traceSourceClientStub = new TraceSourceClientStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const sut = new SyncTracesToDbUseCase({
    traceSourceClient: traceSourceClientStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
  });

  return {
    sut,
    traceSourceClientStub,
    priceVersionRepositoryStub,
    traceRepositoryStub,
  };
};

describe('SyncTracesToDbUseCase', () => {
  describe('Price resolution (QA19)', () => {
    it('MUST resolve prices as-of the TRACE date (startedAt), per trace', async () => {
      const { sut, priceVersionRepositoryStub } = makeSut();
      const findPricesSpy = jest.spyOn(
        priceVersionRepositoryStub,
        'findEffectivePrices',
      );

      await sut.sync(WINDOW);

      expect(findPricesSpy).toHaveBeenCalledWith(
        'openai/gpt-5-mini',
        new Date('2026-06-05T14:00:00.000Z'),
      );
    });

    it('MUST NOT look up prices for a trace without model — it goes pending', async () => {
      const { sut, traceSourceClientStub, priceVersionRepositoryStub, traceRepositoryStub } =
        makeSut();

      traceSourceClientStub.traces = [makeTrace({ model: undefined })];
      const findPricesSpy = jest.spyOn(
        priceVersionRepositoryStub,
        'findEffectivePrices',
      );

      const report = await sut.sync(WINDOW);

      expect(findPricesSpy).not.toHaveBeenCalled();
      expect(report.pendingPrice).toBe(1);
      expect(traceRepositoryStub.inserted[0]?.pricingStatus).toBe(
        'pending_price',
      );
      expect(
        traceRepositoryStub.inserted[0]?.totalCostMicrocents,
      ).toBeUndefined();
    });
  });

  describe('Stamping at write time', () => {
    it('MUST persist the trace already stamped with cost per token type', async () => {
      const { sut, traceRepositoryStub } = makeSut();

      await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(stored?.pricingStatus).toBe('stamped');
      expect(stored?.totalCostMicrocents).toBe(
        1200 * 275 + 350 * 275,
      );
      expect(stored?.stampedCosts).toHaveLength(2);
    });

    it('MUST consolidate derived snapshot fields at write time (decision 51)', async () => {
      const { sut, traceRepositoryStub } = makeSut();

      await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(stored?.tokensTotal).toBe(1200 + 350);
      // Every span carries its offset from the trace start — readers never
      // re-derive it from timestamps.
      for (const span of stored?.spans ?? []) {
        expect(span.offsetMs).toBe(
          span.startedAt.getTime() - (stored?.startedAt.getTime() ?? 0),
        );
      }
    });
  });

  describe('Idempotency and attribution (invariant 7)', () => {
    it('MUST refresh ONLY attribution when the trace already exists', async () => {
      const { sut, traceRepositoryStub } = makeSut();

      traceRepositoryStub.insertResult = 'skipped';

      const report = await sut.sync(WINDOW);

      expect(report.inserted).toBe(0);
      expect(report.skipped).toBe(1);
      expect(traceRepositoryStub.attributionUpdates).toEqual([
        {
          traceId: 'trace-001',
          attribution: {
            agent: {
              id: 'agent-atendimento',
              version: '1.4.2',
              instance: 'agent-atendimento-7d9f4b-k2xp8',
            },
            model: 'openai/gpt-5-mini',
            domain: 'varejo',
            subdomain: undefined,
          },
        },
      ]);
    });
  });

  describe('Unclassified traces (T3)', () => {
    it('MUST store traces with missing attribution, flagged with reasons', async () => {
      const { sut, traceSourceClientStub, traceRepositoryStub } = makeSut();

      traceSourceClientStub.traces = [
        makeTrace({ agent: undefined, model: undefined }),
      ];

      await sut.sync(WINDOW);

      expect(traceRepositoryStub.inserted).toHaveLength(1);
      expect(traceRepositoryStub.inserted[0]?.unclassified).toEqual({
        reasons: ['missing agentId', 'missing model'],
      });
    });
  });
});
