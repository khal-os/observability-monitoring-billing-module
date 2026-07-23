import {
  BatchSyncReport,
  PriceVersionRepository,
  SyncBatchesUseCase,
  SyncCursor,
  SyncStateRepository,
  TraceBatchSource,
  TraceRepository,
} from './sync-batches-protocols.js';
import { ingestSourceTrace } from '../syncTraces/trace-ingestor.js';

/**
 * One bounded step of the watermark loop (T2 continuous form). The
 * protocol that makes every failure mode safe:
 *
 *   1. read cursor → 2. fetch ≤ batchSize rows past it → 3. ingest ALL of
 *   them → 4. only then persist the advanced cursor.
 *
 * A crash anywhere leaves the cursor un-advanced; the re-read batch is
 * deduplicated by insertIfAbsent. Work first, bookmark second — never the
 * other way around. Memory is bounded by batchSize per step, regardless
 * of backlog size.
 */
export class SyncBatchesToDbUseCase implements SyncBatchesUseCase {
  private readonly traceBatchSource: TraceBatchSource;
  private readonly syncStateRepository: SyncStateRepository;
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly batchSize: number;
  private readonly quietPeriodMs: number;
  private readonly now: () => Date;

  constructor(args: {
    traceBatchSource: TraceBatchSource;
    syncStateRepository: SyncStateRepository;
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    batchSize: number;
    /** decision 61: only rows quiet for this long are eligible — the
     * source builds traces incrementally and the stamp is immutable. */
    quietPeriodMs: number;
    /** Test seam. */
    now?: () => Date;
  }) {
    this.traceBatchSource = args.traceBatchSource;
    this.syncStateRepository = args.syncStateRepository;
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
    this.batchSize = args.batchSize;
    this.quietPeriodMs = args.quietPeriodMs;
    this.now = args.now ?? ((): Date => new Date());
  }

  async syncNextBatch(): Promise<BatchSyncReport> {
    const cursor: SyncCursor | null =
      await this.syncStateRepository.getTraceCursor();

    const batch = await this.traceBatchSource.fetchBatch({
      after: cursor,
      limit: this.batchSize,
      updatedBefore: new Date(this.now().getTime() - this.quietPeriodMs),
    });

    const report: BatchSyncReport = {
      scanned: batch.scanned,
      inserted: 0,
      skipped: 0,
      pendingPrice: 0,
      caughtUp: batch.scanned < this.batchSize,
    };

    for (const trace of batch.traces) {
      const result = await ingestSourceTrace(
        {
          priceVersionRepository: this.priceVersionRepository,
          traceRepository: this.traceRepository,
        },
        trace,
      );

      if (result.outcome === 'inserted') {
        report.inserted += 1;

        if (result.pendingPrice) {
          report.pendingPrice += 1;
        }

        continue;
      }

      report.skipped += 1;
    }

    // Only now — the whole batch is in the store (work first, bookmark
    // second). An empty batch keeps the cursor untouched.
    if (batch.nextCursor !== null) {
      await this.syncStateRepository.setTraceCursor(batch.nextCursor);
    }

    if (report.scanned > 0) {
      console.log(
        `Sync: batch of ${report.scanned} — inserted ${report.inserted}, ` +
          `skipped ${report.skipped}, pending price ${report.pendingPrice}` +
          `${report.caughtUp ? ' (caught up)' : ''}.`,
      );
    }

    return report;
  }
}
