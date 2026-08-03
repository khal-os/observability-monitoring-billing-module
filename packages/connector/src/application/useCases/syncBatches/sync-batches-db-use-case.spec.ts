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
} from '@observability/core/domain/models/price-version-model.js';
import { TraceModel } from '@observability/core/domain/models/trace-model.js';
import { SyncBatchesDbUseCase } from './sync-batches-db-use-case.js';
import { InMemoryBillingPeriodRepository } from '@observability/core/application/testSupport/billing-test-fakes.js';

const NOW = new Date('2026-07-23T15:00:00.000Z');
const QUIET_MS = 900_000;

/**
 * An infra-class store failure, in the SHAPE the driver produces (the
 * classifier is duck-typed on purpose — see isSystemicStoreError).
 */
const mongoNetworkError = (): Error => {
  const error = new Error('connection 4 to mongo:27017 closed');

  error.name = 'MongoNetworkError';

  return error;
};

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

  // Port member (audit B-1) — the batch sync never reconciles; no-op stub.
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

const makeSut = (args?: {
  batchSize?: number;
  traceBatchSource?: TraceBatchSourceStub;
}) => {
  const traceBatchSourceStub = args?.traceBatchSource ?? new TraceBatchSourceStub();
  const syncStateRepositoryStub = new SyncStateRepositoryStub();
  const priceVersionRepositoryStub = new PriceVersionRepositoryStub();
  const traceRepositoryStub = new TraceRepositoryStub();
  const ingestFailureRepositoryStub = new IngestFailureRepositoryStub();
  const billingPeriodRepository = new InMemoryBillingPeriodRepository();
  const sut = new SyncBatchesDbUseCase({
    traceBatchSource: traceBatchSourceStub,
    syncStateRepository: syncStateRepositoryStub,
    priceVersionRepository: priceVersionRepositoryStub,
    traceRepository: traceRepositoryStub,
    billingPeriodRepository,
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
    billingPeriodRepository,
  };
};

describe('SyncBatchesDbUseCase', () => {
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
        kind: 'ingest_failure',
        context: 'cursor=start',
        error: expect.stringContaining('store down at trace-002'),
      }),
    ]);

    warn.mockRestore();
  });

  it('MUST dead-letter a SMALL all-failing batch (trace-shaped errors) and STILL advance — documented steady-state semantics', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      ingestFailureRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = Array.from({ length: 3 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-2'),
      scanned: 3,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }

    const report = await sut.syncNextBatch();

    expect(report).toMatchObject({ scanned: 3, inserted: 0, failed: 3 });
    expect(ingestFailureRepositoryStub.failures).toHaveLength(3);
    // Below the ≥10 breaker, three poison traces are three poison traces —
    // parking them and moving on is the B-3 contract.
    expect(syncStateRepositoryStub.writes).toEqual([cursorOf('trace-2')]);

    warn.mockRestore();
  });

  it('MUST rethrow an INFRA-class failure without parking or advancing — the steady-state hole the ≥10 breaker cannot see (re-audit sync item 2)', async () => {
    const {
      sut,
      traceBatchSourceStub,
      syncStateRepositoryStub,
      ingestFailureRepositoryStub,
      traceRepositoryStub,
    } = makeSut({ batchSize: 10 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const traces = Array.from({ length: 3 }, (_, index) =>
      makeTrace(`trace-${index}`),
    );

    traceBatchSourceStub.batch = {
      traces,
      nextCursor: cursorOf('trace-2'),
      scanned: 3,
    };
    for (const trace of traces) {
      traceRepositoryStub.failOn.add(trace.traceId);
    }
    traceRepositoryStub.failWith = mongoNetworkError;

    await expect(sut.syncNextBatch()).rejects.toThrow(/connection 4 to mongo/);

    // The watermark must NOT move over traces the store could not take,
    // and no dead letter may claim they were examined and rejected.
    expect(syncStateRepositoryStub.writes).toEqual([]);
    expect(ingestFailureRepositoryStub.failures).toEqual([]);

    warn.mockRestore();
  });

  it('MUST rethrow a transaction-labelled failure too (TransientTransactionError)', async () => {
    const { sut, traceRepositoryStub, syncStateRepositoryStub } = makeSut();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    traceRepositoryStub.failOn.add('trace-001');
    traceRepositoryStub.failWith = (): unknown =>
      Object.assign(new Error('transaction aborted'), {
        hasErrorLabel: (label: string) => label === 'TransientTransactionError',
      });

    await expect(sut.syncNextBatch()).rejects.toThrow(/transaction aborted/);
    expect(syncStateRepositoryStub.writes).toEqual([]);

    warn.mockRestore();
  });

  it('MUST quarantine a PAST-month trace whose month closed after the cycle read its set (re-audit sync item 5)', async () => {
    const { sut, traceRepositoryStub, billingPeriodRepository } = makeSut();

    await billingPeriodRepository.markClosed({
      year: 2026,
      month: 7,
      closedAt: new Date('2026-08-01T00:00:00.000Z'),
      snapshotVersion: 1,
      audit: {
        at: new Date('2026-08-01T00:00:00.000Z'),
        action: 'close',
        trigger: 'runbook',
        snapshotVersion: 1,
      },
    });
    // THE stale set: what a cycle that started before the close saw.
    jest.spyOn(billingPeriodRepository, 'listAll').mockResolvedValue([]);

    const report = await sut.syncNextBatch();

    expect(report.quarantined).toBe(1);
    expect(traceRepositoryStub.inserted[0]?.billingQuarantine).toEqual(
      expect.objectContaining({ reason: 'period_closed' }),
    );
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
