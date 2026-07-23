import {
  TraceSourceClient,
  PriceVersionRepository,
  SyncReport,
  SyncTracesUseCase,
  SyncWindowInput,
  TraceRepository,
} from './sync-traces-protocols.js';
import { ingestSourceTrace } from './trace-ingestor.js';

export class SyncTracesToDbUseCase implements SyncTracesUseCase {
  private readonly traceSourceClient: TraceSourceClient;
  private readonly priceVersionRepository: PriceVersionRepository;
  private readonly traceRepository: TraceRepository;

  constructor(args: {
    traceSourceClient: TraceSourceClient;
    priceVersionRepository: PriceVersionRepository;
    traceRepository: TraceRepository;
  }) {
    this.traceSourceClient = args.traceSourceClient;
    this.priceVersionRepository = args.priceVersionRepository;
    this.traceRepository = args.traceRepository;
  }

  async sync(window: SyncWindowInput): Promise<SyncReport> {
    const traces = await this.traceSourceClient.fetchTraces(window);

    const report: SyncReport = {
      window,
      fetched: traces.length,
      inserted: 0,
      skipped: 0,
      pendingPrice: 0,
    };

    for (const trace of traces) {
      // Shared ingestion path (trace-ingestor.ts): stamping rules — QA19
      // as-of pricing, invariant-7 attribution refresh — live there, once,
      // for both the windowed and the continuous sync.
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

    // T2 (PoC stubs): every run is logged; gap detection and retention-age
    // alerts are log-only stubs for now.
    console.log(
      `Sync: window [${window.from.toISOString()}, ${window.to.toISOString()}) — fetched ${report.fetched}, inserted ${report.inserted}, skipped ${report.skipped}, pending price ${report.pendingPrice}.`,
    );
    console.log(
      'Sync stub: gap detection and retention-window alerts not implemented in the PoC (T2).',
    );

    return report;
  }
}
