import {
  EffectivePrices,
  EstimateDocumentBytes,
  IngestFailureRecord,
  IngestFailureRepository,
  IngestTruncationRecord,
  InsertIfAbsentResult,
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
import { InMemoryBillingPeriodRepository } from '../billingStatement/billing-test-fakes.js';

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
  pages: SourceTrace[][] = [[makeTrace()]];

  async *fetchTracesPaged(window: SyncWindow): AsyncIterable<SourceTrace[]> {
    for (const page of this.pages) {
      yield page;
    }
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
      pricingType: 'fixed_brl',
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
  insertResult: InsertIfAbsentResult = 'inserted';
  failOn = new Set<string>();

  async insertIfAbsent(trace: TraceModel): Promise<InsertIfAbsentResult> {
    if (this.failOn.has(trace.traceId)) {
      throw new Error(`store down at ${trace.traceId}`);
    }

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

class IngestFailureRepositoryStub implements IngestFailureRepository {
  failures: IngestFailureRecord[] = [];
  truncations: IngestTruncationRecord[] = [];

  async recordFailure(record: IngestFailureRecord): Promise<void> {
    this.failures.push(record);
  }

  async recordTruncation(record: IngestTruncationRecord): Promise<void> {
    this.truncations.push(record);
  }
}

const SMALL_DOCUMENT_BYTES = 1024;

const makeSut = (args?: { estimateDocumentBytes?: EstimateDocumentBytes }) => {
  const traceSourceClientStub = new TraceSourceClientStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const ingestFailureRepositoryStub = new IngestFailureRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const sut = new SyncTracesToDbUseCase({
    traceSourceClient: traceSourceClientStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
    billingPeriodRepository,
    ingestFailureRepository: ingestFailureRepositoryStub,
    estimateDocumentBytes:
      args?.estimateDocumentBytes ?? ((): number => SMALL_DOCUMENT_BYTES),
  });

  return {
    sut,
    traceSourceClientStub,
    priceVersionRepositoryStub,
    traceRepositoryStub,
    ingestFailureRepositoryStub,
    billingPeriodRepository,
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

      traceSourceClientStub.pages = [[makeTrace({ model: undefined })]];
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

    it('MUST carry userId, environment and experiment into the stored trace (decision 70)', async () => {
      const { sut, traceSourceClientStub, traceRepositoryStub } = makeSut();

      traceSourceClientStub.pages = [[
        makeTrace({
          userId: 'user-5511987654321',
          environment: 'prod',
          experiment: { name: 'assistant-tone', variant: 'B', variantVersion: '2' },
        }),
      ]];

      await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(stored?.userId).toBe('user-5511987654321');
      expect(stored?.environment).toBe('prod');
      expect(stored?.experiment).toEqual({
        name: 'assistant-tone',
        variant: 'B',
        variantVersion: '2',
      });
    });

    it('MUST store absent enrichment as undefined at the mapper (null at the write boundary)', async () => {
      const { sut, traceRepositoryStub } = makeSut();

      await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(stored?.userId).toBeUndefined();
      expect(stored?.environment).toBeUndefined();
      expect(stored?.experiment).toBeUndefined();
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
            model: { id: 'gpt-5-mini', provider: 'openai' },
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

      traceSourceClientStub.pages = [[
        makeTrace({ agent: undefined, model: undefined }),
      ]];

      await sut.sync(WINDOW);

      expect(traceRepositoryStub.inserted).toHaveLength(1);
      expect(traceRepositoryStub.inserted[0]?.unclassified).toEqual({
        reasons: ['missing agentId', 'missing model'],
      });
    });
  });

  describe('Per-trace isolation and dead-letter (audit B-3)', () => {
    it('MUST dead-letter a poison trace mid-batch and continue with the rest', async () => {
      const {
        sut,
        traceSourceClientStub,
        traceRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      traceSourceClientStub.pages = [[
        makeTrace({ traceId: 'trace-001' }),
        makeTrace({ traceId: 'trace-poison' }),
        makeTrace({ traceId: 'trace-003' }),
      ]];
      traceRepositoryStub.failOn.add('trace-poison');

      const report = await sut.sync(WINDOW);

      expect(report).toMatchObject({ fetched: 3, inserted: 2, failed: 1 });
      expect(traceRepositoryStub.inserted.map((trace) => trace.traceId)).toEqual(
        ['trace-001', 'trace-003'],
      );
      expect(ingestFailureRepositoryStub.failures).toEqual([
        expect.objectContaining({
          traceId: 'trace-poison',
          context: 'window=[2026-06-01T00:00:00.000Z, 2026-06-15T00:00:00.000Z)',
          error: expect.stringContaining('store down at trace-poison'),
        }),
      ]);

      warn.mockRestore();
    });

    it('MUST throw WITHOUT dead-letter salvation when a whole non-trivial page fails — store outage, not poison', async () => {
      const {
        sut,
        traceSourceClientStub,
        traceRepositoryStub,
      } = makeSut();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const page = Array.from({ length: 10 }, (_, index) =>
        makeTrace({ traceId: `trace-${index}` }),
      );

      traceSourceClientStub.pages = [page];
      for (const trace of page) {
        traceRepositoryStub.failOn.add(trace.traceId);
      }

      await expect(sut.sync(WINDOW)).rejects.toThrow(/store outage/);

      warn.mockRestore();
    });
  });

  describe('Oversized traces (audit B-3/Q8 size guard)', () => {
    const HUGE = 'HUGE_CONTENT_MARKER';
    const OVERSIZE_BYTES = 20 * 1024 * 1024;
    // Content-sensitive estimator: anything still carrying the huge
    // payload reads as oversized; clipped documents read small.
    const estimator: EstimateDocumentBytes = (document) =>
      JSON.stringify(document)?.includes(HUGE)
        ? OVERSIZE_BYTES
        : SMALL_DOCUMENT_BYTES;

    it('MUST store the trace with truncated content markers, flag it, and keep tokens/costs intact', async () => {
      const {
        sut,
        traceSourceClientStub,
        traceRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut({ estimateDocumentBytes: estimator });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      traceSourceClientStub.pages = [[
        makeTrace({
          spans: [
            {
              spanId: 'span-1',
              type: 'llm',
              name: 'chat',
              startedAt: new Date('2026-06-05T14:00:00.000Z'),
              finishedAt: new Date('2026-06-05T14:00:02.000Z'),
              status: 'ok',
              input: HUGE,
              output: 'resposta',
            },
          ],
        }),
      ]];

      const report = await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(report).toMatchObject({ inserted: 1, failed: 0 });
      expect(stored?.contentTruncated).toBe(true);
      expect(stored?.spans[0]?.input).toEqual({
        truncated: true,
        originalBytes: OVERSIZE_BYTES,
      });
      expect(stored?.spans[0]?.output).toEqual({
        truncated: true,
        originalBytes: SMALL_DOCUMENT_BYTES,
      });
      // Trace-level content survives — clipping the spans was enough.
      expect(stored?.input).toBe('entrada');
      // Tokens and the stamp are computed from counts, not content.
      expect(stored?.tokensTotal).toBe(1200 + 350);
      expect(stored?.pricingStatus).toBe('stamped');
      expect(stored?.totalCostMicrocents).toBe(1200 * 275 + 350 * 275);

      // Recorded as a truncation EVENT, not a failure.
      expect(ingestFailureRepositoryStub.truncations).toEqual([
        expect.objectContaining({
          traceId: 'trace-001',
          originalBytes: OVERSIZE_BYTES,
        }),
      ]);
      expect(ingestFailureRepositoryStub.failures).toEqual([]);

      warn.mockRestore();
    });
  });

  describe('Token divergence on skipped re-syncs (audit B-4 residual, Q3)', () => {
    it('MUST count + warn when the source now reports more tokens than stored — never mutating anything', async () => {
      const { sut, traceRepositoryStub } = makeSut();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      // Stored total (100) ≠ source total (1200 + 350).
      traceRepositoryStub.insertResult = {
        outcome: 'skipped',
        storedTokensTotal: 100,
      };

      const report = await sut.sync(WINDOW);

      expect(report).toMatchObject({ skipped: 1, tokenDivergence: 1 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('divergent token totals'),
      );
      // Attribution refresh still happens; nothing else is touched.
      expect(traceRepositoryStub.attributionUpdates).toHaveLength(1);

      warn.mockRestore();
    });

    it('MUST NOT count divergence when the skipped branch reports a matching total', async () => {
      const { sut, traceRepositoryStub } = makeSut();

      traceRepositoryStub.insertResult = {
        outcome: 'skipped',
        storedTokensTotal: 1200 + 350,
      };

      const report = await sut.sync(WINDOW);

      expect(report).toMatchObject({ skipped: 1, tokenDivergence: 0 });
    });
  });

  describe('Closed-month quarantine (T6, closed months loaded once — audit C-7.3)', () => {
    it('MUST quarantine a trace dated inside a closed month', async () => {
      const { sut, traceRepositoryStub, billingPeriodRepository } = makeSut();

      await billingPeriodRepository.markClosed({
        year: 2026,
        month: 6,
        closedAt: new Date('2026-07-01T00:00:00.000Z'),
        snapshotVersion: 1,
        audit: {
          at: new Date('2026-07-01T00:00:00.000Z'),
          action: 'close',
          trigger: 'runbook',
          snapshotVersion: 1,
        },
      });

      const report = await sut.sync(WINDOW);

      expect(report.quarantined).toBe(1);
      expect(traceRepositoryStub.inserted[0]?.billingQuarantine).toEqual(
        expect.objectContaining({ reason: 'period_closed' }),
      );
    });
  });
});
