import {
  BatchSyncReport,
  IngestFailureRepository,
  PriceVersionRepository,
  SyncBatchesUseCase,
  SyncCursor,
  SyncStateRepository,
  TraceBatchSource,
  TraceRepository,
} from './sync-batches-protocols.js';
import { EstimateDocumentBytes } from '../../interfaces/ingest-failure-repository.js';
import {
  assertNotAllFailed,
  closedMonthKeys,
  ingestFailureKindOf,
  ingestSourceTrace,
  isSystemicStoreError,
} from '../syncTraces/trace-ingestor.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';

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
 *
 * audit B-3: "ingest ALL of them" tolerates per-trace poison — a failing
 * trace is dead-lettered (ingest_failures) and the batch continues, so
 * one deterministic failure can no longer park the cursor forever while
 * the source's ~49-day retention burns. The cursor still advances only
 * after the batch was fully SCANNED; an all-fail batch (store outage,
 * not poison) throws without advancing.
 */
export class SyncBatchesDbUseCase implements SyncBatchesUseCase {
  private readonly traceBatchSource: TraceBatchSource;
  private readonly syncStateRepository: SyncStateRepository;
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly ingestFailureRepository: IngestFailureRepository;
  private readonly estimateDocumentBytes: EstimateDocumentBytes;
  private readonly batchSize: number;
  private readonly quietPeriodMs: number;
  private readonly now: () => Date;

  constructor(args: {
    traceBatchSource: TraceBatchSource;
    syncStateRepository: SyncStateRepository;
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
    ingestFailureRepository: IngestFailureRepository;
    estimateDocumentBytes: EstimateDocumentBytes;
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
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.ingestFailureRepository = args.ingestFailureRepository;
    this.estimateDocumentBytes = args.estimateDocumentBytes;
    this.batchSize = args.batchSize;
    this.quietPeriodMs = args.quietPeriodMs;
    this.now = args.now ?? ((): Date => new Date());
  }

  async syncNextBatch(): Promise<BatchSyncReport> {
    const cursor: SyncCursor | null =
      await this.syncStateRepository.getTraceCursor();

    // audit C-6.4: the quiet period is measured against the SOURCE's
    // write times, so it must use the SOURCE's clock when one is
    // available — a worker clock N minutes behind the source silently
    // shrinks the 15-minute quiet period to 15−N (partial-stamp hole).
    const now = this.traceBatchSource.sourceNow
      ? await this.traceBatchSource.sourceNow()
      : this.now();

    const batch = await this.traceBatchSource.fetchBatch({
      after: cursor,
      limit: this.batchSize,
      updatedBefore: new Date(now.getTime() - this.quietPeriodMs),
    });

    const report: BatchSyncReport = {
      scanned: batch.scanned,
      inserted: 0,
      skipped: 0,
      pendingPrice: 0,
      quarantined: 0,
      failed: 0,
      tokenDivergence: 0,
      caughtUp: batch.scanned < this.batchSize,
    };

    // audit C-7.3: one listAll per cycle, not one period lookup per trace
    // (see closedMonthKeys for why a cycle-start read is safe).
    const closedMonths =
      batch.traces.length > 0
        ? closedMonthKeys(await this.billingPeriodRepository.listAll())
        : new Set<string>();

    const context = cursor
      ? `cursor=(${cursor.updatedAt.toISOString()}, ${cursor.traceId})`
      : 'cursor=start';

    for (const trace of batch.traces) {
      try {
        const result = await ingestSourceTrace(
          {
            priceVersionRepository: this.priceVersionRepository,
            traceRepository: this.traceRepository,
            billingPeriodRepository: this.billingPeriodRepository,
            ingestFailureRepository: this.ingestFailureRepository,
            estimateDocumentBytes: this.estimateDocumentBytes,
          },
          trace,
          closedMonths,
        );

        if (result.quarantined) {
          report.quarantined += 1;
        }

        if (result.outcome === 'inserted') {
          report.inserted += 1;

          if (result.pendingPrice) {
            report.pendingPrice += 1;
          }

          continue;
        }

        if (result.tokenDivergence) {
          report.tokenDivergence += 1;
        }

        report.skipped += 1;
      } catch (error) {
        // re-audit 2026-08 (sync item 2): an infra-class failure is not
        // poison. Dead-lettering it would park good traces AND advance the
        // watermark past them — the steady-state hole the ≥10 breaker
        // cannot see (a caught-up worker runs 1–9-trace batches). Rethrow:
        // the batch aborts BEFORE the bookmark, the cursor stays put.
        if (isSystemicStoreError(error)) {
          throw error;
        }

        // audit B-3: per-trace isolation — the dead-letter row is the
        // recovery trail; the batch continues and the cursor advances
        // past the poison trace instead of re-reading it forever.
        report.failed += 1;
        console.warn(
          `Sync: trace ${trace.traceId} failed ingestion and was dead-lettered: ${String(error)}`,
        );
        await this.ingestFailureRepository.recordFailure({
          traceId: trace.traceId,
          kind: ingestFailureKindOf(error),
          context,
          error: String(error),
          seenAt: new Date(),
        });
      }
    }

    // audit B-3 breaker: an all-fail non-trivial batch is a store outage,
    // not poison — throw BEFORE the bookmark, keeping the batch re-runnable.
    assertNotAllFailed(batch.traces.length, report.failed);

    // Only now — the whole batch is in the store or dead-lettered (work
    // first, bookmark second). An empty batch keeps the cursor untouched.
    if (batch.nextCursor !== null) {
      await this.syncStateRepository.setTraceCursor(batch.nextCursor);
    }

    if (report.scanned > 0) {
      console.log(
        `Sync: batch of ${report.scanned} — inserted ${report.inserted}, ` +
          `skipped ${report.skipped}, pending price ${report.pendingPrice}, ` +
          `failed ${report.failed}` +
          `${report.tokenDivergence > 0 ? `, token divergence ${report.tokenDivergence}` : ''}` +
          `${report.caughtUp ? ' (caught up)' : ''}.`,
      );
    }

    return report;
  }
}
