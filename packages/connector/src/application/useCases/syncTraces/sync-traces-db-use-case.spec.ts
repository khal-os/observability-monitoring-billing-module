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
import { PriceVersionModel, TokenType } from '@observability/core/domain/models/price-version-model.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';
import { SyncTracesDbUseCase } from './sync-traces-db-use-case.js';
import { InMemoryBillingPeriodRepository } from '@observability/core/application/testSupport/billing-test-fakes.js';

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
  /** What a failOn trace throws — the classifier tests need infra shapes. */
  failWith: (traceId: string) => unknown = (traceId) =>
    new Error(`store down at ${traceId}`);

  async insertIfAbsent(trace: TraceModel): Promise<InsertIfAbsentResult> {
    if (this.failOn.has(trace.traceId)) {
      throw this.failWith(trace.traceId);
    }

    if (this.insertResult === 'inserted') {
      this.inserted.push(trace);
    }

    return this.insertResult;
  }

  modelPinnedByStamp = false;

  async updateAttribution(
    traceId: string,
    attribution: TraceAttribution,
  ): Promise<{ modelPinnedByStamp: boolean }> {
    this.attributionUpdates.push({ traceId, attribution });

    return { modelPinnedByStamp: this.modelPinnedByStamp };
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

  // Port member (audit B-1) — the sync never reconciles; no-op stub.
  async reconcileQuarantineAfterClose(): Promise<{
    flaggedStragglers: number;
    absorbed: number;
  }> {
    return { flaggedStragglers: 0, absorbed: 0 };
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

  async countUnresolved(): Promise<number> {
    return this.failures.length;
  }
}

const SMALL_DOCUMENT_BYTES = 1024;

/**
 * An infra-class store failure, in the SHAPE the driver produces (the
 * classifier is duck-typed on purpose — see isSystemicStoreError).
 */
const mongoNetworkError = (): Error => {
  const error = new Error('connection 4 to mongo:27017 closed');

  error.name = 'MongoNetworkError';

  return error;
};

const makeSut = (args?: { estimateDocumentBytes?: EstimateDocumentBytes }) => {
  const traceSourceClientStub = new TraceSourceClientStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const ingestFailureRepositoryStub = new IngestFailureRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const sut = new SyncTracesDbUseCase({
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

describe('SyncTracesDbUseCase', () => {
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
          kind: 'ingest_failure',
          context: 'window=[2026-06-01T00:00:00.000Z, 2026-06-15T00:00:00.000Z)',
          error: expect.stringContaining('store down at trace-poison'),
        }),
      ]);

      warn.mockRestore();
    });

    it('MUST dead-letter a SMALL all-failing page (trace-shaped errors) and finish the run — the breaker is for outages', async () => {
      const { sut, traceSourceClientStub, traceRepositoryStub, ingestFailureRepositoryStub } =
        makeSut();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const page = Array.from({ length: 3 }, (_, index) =>
        makeTrace({ traceId: `trace-${index}` }),
      );

      traceSourceClientStub.pages = [page];
      for (const trace of page) {
        traceRepositoryStub.failOn.add(trace.traceId);
      }

      const report = await sut.sync(WINDOW);

      // Documented semantics: below the ≥10 breaker, trace-shaped failures
      // are poison — parked, and the run completes (the window is the
      // windowed sync's cursor: re-running it re-reads the same traces).
      expect(report).toMatchObject({ fetched: 3, inserted: 0, failed: 3 });
      expect(ingestFailureRepositoryStub.failures).toHaveLength(3);

      warn.mockRestore();
    });

    it('MUST rethrow an INFRA-class failure instead of dead-lettering it — a store that cannot write is not poison (re-audit sync item 2)', async () => {
      const { sut, traceSourceClientStub, traceRepositoryStub, ingestFailureRepositoryStub } =
        makeSut();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const page = Array.from({ length: 3 }, (_, index) =>
        makeTrace({ traceId: `trace-${index}` }),
      );

      traceSourceClientStub.pages = [page];
      for (const trace of page) {
        traceRepositoryStub.failOn.add(trace.traceId);
      }
      traceRepositoryStub.failWith = mongoNetworkError;

      await expect(sut.sync(WINDOW)).rejects.toThrow(/connection 4 to mongo/);

      // Nothing parked: these traces are still owed to the archive, and the
      // window stays re-runnable.
      expect(ingestFailureRepositoryStub.failures).toEqual([]);

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

    it('MUST clip span errorMessage bulk too, and record the truncation ONLY AFTER the insert landed (re-audit sync item 4)', async () => {
      const {
        sut,
        traceSourceClientStub,
        traceRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut({ estimateDocumentBytes: estimator });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const insertSpy = jest.spyOn(traceRepositoryStub, 'insertIfAbsent');
      const truncationSpy = jest.spyOn(
        ingestFailureRepositoryStub,
        'recordTruncation',
      );

      // The bulk is in an error message, not in input/output — the shape
      // the first guard could not reach.
      traceSourceClientStub.pages = [[
        makeTrace({
          spans: [
            {
              spanId: 'span-1',
              type: 'llm',
              name: 'chat',
              startedAt: new Date('2026-06-05T14:00:00.000Z'),
              finishedAt: new Date('2026-06-05T14:00:02.000Z'),
              status: 'error',
              errorMessage: HUGE,
            },
          ],
        }),
      ]];

      const report = await sut.sync(WINDOW);

      const stored = traceRepositoryStub.inserted[0];

      expect(report).toMatchObject({ inserted: 1, failed: 0 });
      expect(stored?.contentTruncated).toBe(true);
      expect(stored?.spans[0]?.errorMessage).toBe(
        `[truncated ${OVERSIZE_BYTES} bytes]`,
      );
      expect(ingestFailureRepositoryStub.truncations).toHaveLength(1);

      // The record describes a STORED trace — so it may only be written
      // after the store call returned (it used to run before the insert,
      // able to describe a write that never happened).
      expect(insertSpy.mock.invocationCallOrder[0]).toBeLessThan(
        truncationSpy.mock.invocationCallOrder[0] as number,
      );

      warn.mockRestore();
    });

    it('MUST dead-letter a still-oversized trace under its own kind, with NO truncation record, counted failed (re-audit sync item 4)', async () => {
      const {
        sut,
        traceSourceClientStub,
        traceRepositoryStub,
        ingestFailureRepositoryStub,
      } = makeSut({
        // Pathological: every clip pass still reads over the cap.
        estimateDocumentBytes: (): number => OVERSIZE_BYTES,
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const report = await sut.sync(WINDOW);

      expect(report).toMatchObject({ fetched: 1, inserted: 0, failed: 1 });
      expect(traceRepositoryStub.inserted).toEqual([]);
      // Honest kind: a re-sync will never fix this one, so it must not
      // look like a re-runnable ingest failure.
      expect(ingestFailureRepositoryStub.failures).toEqual([
        expect.objectContaining({
          traceId: 'trace-001',
          kind: 'oversized_unstorable',
          error: expect.stringContaining('still exceeds'),
        }),
      ]);
      // No truncation record: nothing was stored to describe.
      expect(ingestFailureRepositoryStub.truncations).toEqual([]);

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

    it('MUST reload the closed-months set PER PAGE — a multi-hour backfill cannot ride one snapshot (re-audit sync item 5)', async () => {
      const { sut, traceSourceClientStub, billingPeriodRepository } = makeSut();
      const listAllSpy = jest.spyOn(billingPeriodRepository, 'listAll');

      traceSourceClientStub.pages = [
        [makeTrace({ traceId: 'trace-001' })],
        [makeTrace({ traceId: 'trace-002' })],
        [makeTrace({ traceId: 'trace-003' })],
      ];

      await sut.sync(WINDOW);

      expect(listAllSpy).toHaveBeenCalledTimes(3);
    });

    it('MUST quarantine a PAST-month trace whose month closed after the set was read — stale set, fresh double-check (re-audit sync item 5)', async () => {
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
      // THE stale set: what a cycle that started before the close saw.
      jest.spyOn(billingPeriodRepository, 'listAll').mockResolvedValue([]);

      const report = await sut.sync(WINDOW);

      expect(report.quarantined).toBe(1);
      expect(traceRepositoryStub.inserted[0]?.billingQuarantine).toEqual(
        expect.objectContaining({ reason: 'period_closed' }),
      );
    });

    it('MUST NOT pay a period lookup for a CURRENT-month trace — the hot path stays N+1-free (re-audit sync item 5)', async () => {
      const { sut, traceSourceClientStub, billingPeriodRepository } = makeSut();
      const findSpy = jest.spyOn(billingPeriodRepository, 'find');
      const now = new Date();
      // Mid-month, current UTC month: the steady-state shape.
      const startedAt = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12),
      );

      traceSourceClientStub.pages = [[
        makeTrace({
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 4000),
        }),
      ]];

      await sut.sync(WINDOW);

      expect(findSpy).not.toHaveBeenCalled();
    });
  });
});
