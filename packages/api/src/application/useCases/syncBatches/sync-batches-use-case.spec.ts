import {
  EffectivePrices,
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
  insertResult: 'inserted' | 'skipped' = 'inserted';
  failOn?: string;

  async insertIfAbsent(trace: TraceModel): Promise<'inserted' | 'skipped'> {
    if (this.failOn === trace.traceId) {
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

const makeSut = (args?: { batchSize?: number }) => {
  const traceBatchSourceStub = new TraceBatchSourceStub();
  const syncStateRepositoryStub = new SyncStateRepositoryStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const sut = new SyncBatchesToDbUseCase({
    traceBatchSource: traceBatchSourceStub,
    syncStateRepository: syncStateRepositoryStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
    batchSize: args?.batchSize ?? 2,
    quietPeriodMs: QUIET_MS,
    now: () => NOW,
  });

  return {
    sut,
    traceBatchSourceStub,
    syncStateRepositoryStub,
    traceRepositoryStub,
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

  it('MUST ingest the batch and only then advance the cursor (work first, bookmark second)', async () => {
    const { sut, syncStateRepositoryStub, traceRepositoryStub } = makeSut();

    const report = await sut.syncNextBatch();

    expect(traceRepositoryStub.inserted.map((trace) => trace.traceId)).toEqual(
      ['trace-001'],
    );
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-001')]);
    expect(report).toMatchObject({ scanned: 1, inserted: 1, caughtUp: true });
  });

  it('MUST NOT advance the cursor when ingestion fails mid-batch', async () => {
    const { sut, traceBatchSourceStub, syncStateRepositoryStub, traceRepositoryStub } =
      makeSut();

    traceBatchSourceStub.batch = {
      traces: [makeTrace('trace-001'), makeTrace('trace-002')],
      nextCursor: cursorOf('trace-002'),
      scanned: 2,
    };
    traceRepositoryStub.failOn = 'trace-002';

    await expect(sut.syncNextBatch()).rejects.toThrow('store down');

    // Crash story: cursor untouched → the batch is re-read next cycle and
    // trace-001 is deduplicated by insertIfAbsent.
    expect(syncStateRepositoryStub.writes).toEqual([]);
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
});
