import {
  EffectivePrices,
  IngestFailureRecord,
  IngestFailureRepository,
  IngestTruncationRecord,
  InsertIfAbsentResult,
  PendingStamp,
  PriceVersionRepository,
  SourceTrace,
  SyncCursor,
  SyncStateRepository,
  TraceAttribution,
  TraceBatch,
  TraceBatchSource,
  TraceRepository,
} from './sync-batches-protocols.js';
import {
  PriceVersionModel,
  TokenType,
} from '../../../domain/models/price-version-model.js';
import { TraceModel } from '../../../domain/models/trace-model.js';
import { SyncBatchesToDbUseCase } from './sync-batches-use-case.js';
import { InMemoryBillingPeriodRepository } from '../billingStatement/billing-test-fakes.js';

const NOW = new Date('2026-07-23T15:00:00.000Z');
const QUIET_MS = 900_000;

const makeTrace = (traceId: string): SourceTrace => ({
  traceId,
  sessionId: 'sess-001',
  agent: { id: 'agent-atendimento' },
  model: 'openai/gpt-5-mini',
  type: 'chat',
  channel: { type: 'whatsapp' },
  startedAt: new Date('2026-07-23T14:00:00.000Z'),
  finishedAt: new Date('2026-07-23T14:00:04.000Z'),
  status: 'ok',
  tokens: { input: 1200, output: 350 },
  input: 'entrada',
  output: 'saída',
  spans: [],
});

const cursorOf = (traceId: string): SyncCursor => ({
  updatedAt: new Date('2026-07-23T14:30:00.000Z'),
  traceId,
});

class TraceBatchSourceStub implements TraceBatchSource {
  batch: TraceBatch = {
    traces: [makeTrace('trace-001')],
    nextCursor: cursorOf('trace-001'),
    scanned: 1,
  };
  calls: { after: SyncCursor | null; limit: number; updatedBefore: Date }[] =
    [];

  async fetchBatch(args: {
    after: SyncCursor | null;
    limit: number;
    updatedBefore: Date;
  }): Promise<TraceBatch> {
    this.calls.push(args);

    return this.batch;
  }
}

/** audit C-6.4: a source that CAN serve its own clock (skewed from the worker's). */
class ClockedTraceBatchSourceStub extends TraceBatchSourceStub {
  sourceClock = new Date(NOW.getTime() + 120_000);

  async sourceNow(): Promise<Date> {
    return this.sourceClock;
  }
}

class SyncStateRepositoryStub implements SyncStateRepository {
  cursor: SyncCursor | null = null;
  writes: SyncCursor[] = [];

  async getTraceCursor(): Promise<SyncCursor | null> {
    return this.cursor;
  }

  async setTraceCursor(cursor: SyncCursor): Promise<void> {
    this.writes.push(cursor);
    this.cursor = cursor;
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
      effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
    });

    return { input: price('input'), output: price('output') };
  }

  async insertVersion(): Promise<void> {}
}

class TraceRepositoryStub implements TraceRepository {
  inserted: TraceModel[] = [];
  attributionUpdates: { traceId: string; attribution: TraceAttribution }[] =
    [];
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

const makeSut = (args?: {
  batchSize?: number;
  traceBatchSource?: TraceBatchSourceStub;
}) => {
  const traceBatchSourceStub = args?.traceBatchSource ?? new TraceBatchSourceStub();
  const syncStateRepositoryStub = new SyncStateRepositoryStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const ingestFailureRepositoryStub = new IngestFailureRepositoryStub();
  const sut = new SyncBatchesToDbUseCase({
    traceBatchSource: traceBatchSourceStub,
    syncStateRepository: syncStateRepositoryStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
    billingPeriodRepository: new InMemoryBillingPeriodRepository(),
    ingestFailureRepository: ingestFailureRepositoryStub,
    estimateDocumentBytes: (): number => 1024,
    batchSize: args?.batchSize ?? 2,
    quietPeriodMs: QUIET_MS,
    now: () => NOW,
  });

  return {
    sut,
    traceBatchSourceStub,
    syncStateRepositoryStub,
    traceRepositoryStub,
    ingestFailureRepositoryStub,
  };
};

describe('SyncBatchesToDbUseCase', () => {
  it('MUST fetch past the stored cursor with the quiet-period ceiling', async () => {
    const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut();

    syncStateRepositoryStub.cursor = cursorOf('trace-000');

    await sut.syncNextBatch();

    expect(traceBatchSourceStub.calls).toEqual([
      {
        after: cursorOf('trace-000'),
        limit: 2,
        updatedBefore: new Date(NOW.getTime() - QUIET_MS),
      },
    ]);
  });

  it('MUST anchor the quiet-period ceiling on the SOURCE clock when the source serves one (audit C-6.4)', async () => {
    const clockedSource = new ClockedTraceBatchSourceStub();
    const { sut, traceBatchSourceStub } = makeSut({
      traceBatchSource: clockedSource,
    });

    await sut.syncNextBatch();

    // Worker clock (NOW) is 2 min behind the source's — using it would
    // shrink the quiet period; the ceiling must ride the source clock.
    expect(traceBatchSourceStub.calls[0]?.updatedBefore).toEqual(
      new Date(clockedSource.sourceClock.getTime() - QUIET_MS),
    );
  });

  it('MUST ingest the batch and only then advance the cursor (work first, bookmark second)', async () => {
    const { sut, syncStateRepositoryStub, traceRepositoryStub } = makeSut();

    const report = await sut.syncNextBatch();

    expect(traceRepositoryStub.inserted.map((trace) => trace.traceId)).toEqual(
      ['trace-001'],
    );
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-001')]);
    expect(report).toMatchObject({ scanned: 1, inserted: 1, caughtUp: true });
  });

  it('MUST dead-letter a poison trace mid-batch, continue, and STILL advance the cursor (audit B-3)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      traceRepositoryStub,
      ingestFailureRepositoryStub,
    } = makeSut();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001'), makeTrace('trace-002')],
      nextCursor: cursorOf('trace-002'),
      scanned: 2,
    };
    traceRepositoryStub.failOn.add('trace-002');

    const report = await sut.syncNextBatch();

    // The poison trace no longer blocks the cursor — the dead-letter row
    // is the recovery trail; head-of-line blocking was the B-3 bug.
    expect(report).toMatchObject({ scanned: 2, inserted: 1, failed: 1 });
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-002')]);
    expect(ingestFailureRepositoryStub.failures).toEqual([
      expect.objectContaining({
        traceId: 'trace-002',
        context: 'cursor=start',
        error: expect.stringContaining('store down at trace-002'),
      }),
    ]);

    warn.mockRestore();
  });

  it('MUST throw WITHOUT advancing when every trace of a non-trivial batch fails — store outage, not poison (audit B-3 breaker)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = Array.from({ length: 10 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-9'),
      scanned: 10,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }

    await expect(sut.syncNextBatch()).rejects.toThrow(/store outage/);

    // Crash story preserved: cursor untouched → the batch is re-read next
    // cycle and deduplicated by insertIfAbsent.
    expect(syncStateRepositoryStub.writes).toEqual([]);

    warn.mockRestore();
  });

  it('MUST keep the cursor untouched on an empty batch', async () => {
    const { sut, traceBatchSourceStub, syncStateRepositoryStub } = makeSut();

    traceBatchSourceStub.batch = { traces: [], nextCursor: null, scanned: 0 };

    const report = await sut.syncNextBatch();

    expect(syncStateRepositoryStub.writes).toEqual([]);
    expect(report).toMatchObject({ scanned: 0, caughtUp: true });
  });

  it('MUST report caughtUp false while full batches keep coming', async () => {
    const { sut, traceBatchSourceStub } = makeSut({ batchSize: 1 });

    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001')],
      nextCursor: cursorOf('trace-001'),
      scanned: 1,
    };

    const report = await sut.syncNextBatch();

    expect(report.caughtUp).toBe(false);
  });

  it('MUST refresh attribution (never the stamp) for already-stored traces', async () => {
    const { sut, traceRepositoryStub } = makeSut();

    traceRepositoryStub.insertResult = 'skipped';

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ inserted: 0, skipped: 1 });
    expect(traceRepositoryStub.attributionUpdates).toHaveLength(1);
  });

  it('MUST count token divergence on a skipped re-sync that reports a different stored total (audit B-4 residual, Q3)', async () => {
    const { sut, traceRepositoryStub } = makeSut();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    traceRepositoryStub.insertResult = {
      outcome: 'skipped',
      storedTokensTotal: 100, // source now says 1200 + 350
    };

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ skipped: 1, tokenDivergence: 1 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('divergent token totals'),
    );

    warn.mockRestore();
  });
});
