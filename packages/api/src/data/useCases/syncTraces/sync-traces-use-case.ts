import {
  TraceSourceClient,
  PriceVersionRepository,
  SyncReport,
  SyncTracesUseCase,
  SyncWindowInput,
  TraceRepository,
} from './sync-traces-protocols.js';
import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { stampTokens } from './price-stamper.js';
import { mapToTrace } from './trace-mapper.js';

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
      // QA19: the stamp uses the price version effective on the TRACE's
      // date (startedAt), resolved as-of at write time — not the price at
      // sync time. A trace dated 31/07 synced on 01/08 keeps July's price.
      const effectivePrices: EffectivePrices = trace.model
        ? await this.priceVersionRepository.findEffectivePrices(
            trace.model,
            trace.startedAt,
          )
        : {};

      const stamp = stampTokens(trace.tokens, effectivePrices);
      const stampedTrace = mapToTrace(trace, stamp, new Date());

      const result = await this.traceRepository.insertIfAbsent(stampedTrace);

      if (result === 'inserted') {
        report.inserted += 1;

        if (stamp.pricingStatus === 'pending_price') {
          report.pendingPrice += 1;
        }

        continue;
      }

      // Invariant 7: attribution (agent/metadata/model) stays mutable in
      // open periods — a re-synced trace refreshes attribution, never the
      // stamp. A pending trace whose model arrives here becomes stampable
      // by the reprocess job (as-of rule, // QA19 above).
      await this.traceRepository.updateAttribution(trace.traceId, {
        agent: trace.agent,
        model: trace.model,
        domain: trace.domain,
        subdomain: trace.subdomain,
      });

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
