import {
  IngestFailureRepository,
  PriceVersionRepository,
  SyncReport,
  SyncTracesUseCase,
  SyncWindowInput,
  TraceRepository,
  TraceSourceClient,
} from './sync-traces-protocols.js';
import { EstimateDocumentBytes } from '../../interfaces/ingest-failure-repository.js';
import {
  assertNotAllFailed,
  closedMonthKeys,
  ingestSourceTrace,
} from './trace-ingestor.js';
import { BillingPeriodRepository } from '../../interfaces/billing-period-repository.js';

export class SyncTracesDbUseCase implements SyncTracesUseCase {
  private readonly traceSourceClient: TraceSourceClient;
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;
  private readonly billingPeriodRepository: BillingPeriodRepository;
  private readonly ingestFailureRepository: IngestFailureRepository;
  private readonly estimateDocumentBytes: EstimateDocumentBytes;

  constructor(args: {
    traceSourceClient: TraceSourceClient;
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
    billingPeriodRepository: BillingPeriodRepository;
    ingestFailureRepository: IngestFailureRepository;
    estimateDocumentBytes: EstimateDocumentBytes;
  }) {
    this.traceSourceClient = args.traceSourceClient;
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
    this.billingPeriodRepository = args.billingPeriodRepository;
    this.ingestFailureRepository = args.ingestFailureRepository;
    this.estimateDocumentBytes = args.estimateDocumentBytes;
  }

  async sync(window: SyncWindowInput): Promise<SyncReport> {
    // audit C-7.3: one listAll per run, not one period lookup per trace
    // (see closedMonthKeys for why a cycle-start read is safe).
    const closedMonths = closedMonthKeys(
      await this.billingPeriodRepository.listAll(),
    );

    const report: SyncReport = {
      window,
      fetched: 0,
      inserted: 0,
      skipped: 0,
      pendingPrice: 0,
      quarantined: 0,
      failed: 0,
      tokenDivergence: 0,
    };

    const context = `window=[${window.from.toISOString()}, ${window.to.toISOString()})`;

    // audit C-6.3: the source streams BOUNDED pages — a 49-day backfill is
    // never buffered whole; each page is ingested and released in turn.
    for await (const page of this.traceSourceClient.fetchTracesPaged(window)) {
      report.fetched += page.length;

      let failedInPage = 0;

      for (const trace of page) {
        // Shared ingestion path (trace-ingestor.ts): stamping rules — QA19
        // as-of pricing, invariant-7 attribution refresh, T6 closed-month
        // quarantine — live there, once, for both syncs.
        try {
          const result = await ingestSourceTrace(
            {
              priceVersionRepository: this.priceVersionRepository,
              traceRepository: this.traceRepository,
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
          // audit B-3: per-trace isolation — one poison trace is
          // dead-lettered and the run continues; without this, a single
          // deterministic failure re-ran forever while the source's
          // retention burned (permanent archive loss).
          failedInPage += 1;
          report.failed += 1;
          console.warn(
            `Sync: trace ${trace.traceId} failed ingestion and was dead-lettered: ${String(error)}`,
          );
          await this.ingestFailureRepository.recordFailure({
            traceId: trace.traceId,
            context,
            error: String(error),
            seenAt: new Date(),
          });
        }
      }

      assertNotAllFailed(page.length, failedInPage);
    }

    // T2 (PoC stubs): every run is logged; gap detection and retention-age
    // alerts are log-only stubs for now.
    console.log(
      `Sync: window [${window.from.toISOString()}, ${window.to.toISOString()}) — fetched ${report.fetched}, inserted ${report.inserted}, skipped ${report.skipped}, pending price ${report.pendingPrice}, failed ${report.failed}` +
        `${report.tokenDivergence > 0 ? `, token divergence ${report.tokenDivergence}` : ''}.`,
    );
    console.log(
      'Sync stub: gap detection and retention-window alerts not implemented in the PoC (T2).',
    );

    return report;
  }
}
