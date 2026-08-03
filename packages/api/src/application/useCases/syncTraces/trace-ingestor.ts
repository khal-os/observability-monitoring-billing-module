import { EffectivePrices } from '../../interfaces/price-version-repository.js';
import { PriceVersionRepository } from '../../interfaces/price-version-repository.js';
import { TraceRepository } from '../../interfaces/trace-repository.js';
import {
  EstimateDocumentBytes,
  IngestFailureRepository,
} from '../../interfaces/ingest-failure-repository.js';
import { SourceTrace } from '../../interfaces/trace-source-client.js';
import { BillingPeriodModel } from '../../../domain/models/billing-period-model.js';
import { modelKey } from '../../../domain/models/model-ref.js';
import { stampTokens } from './price-stamper.js';
import { mapToTrace, sourceModelRef, sumTokens } from './trace-mapper.js';
import { truncateOversizedContent } from './content-size-guard.js';

export interface IngestOutcome {
  outcome: 'inserted' | 'skipped';
  pendingPrice: boolean;
  /** T6: the trace is dated inside a closed month — stored, flagged, not billed. */
  quarantined: boolean;
  /**
   * audit B-4 residual (Q3): a skipped re-sync whose SOURCE token totals
   * no longer match the stored trace (the trace resumed after its quiet
   * period, the extra tokens arrived late). Logged + counted ONLY —
   * neither the stamp (invariant 1) nor the stored counts are mutated.
   */
  tokenDivergence: boolean;
}

export interface IngestDeps {
  priceVersionRepository: PriceVersionRepository;
  traceRepository: TraceRepository;
  ingestFailureRepository: IngestFailureRepository;
  estimateDocumentBytes: EstimateDocumentBytes;
}

/** Month key shared by the sync loops and the reprocess sweep — `${UTC year}-${UTC month}`. */
export const monthKeyOf = (date: Date): string =>
  `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;

/**
 * audit C-7.3: closed months are resolved ONCE per sync cycle (one
 * listAll) and passed into every ingest — the per-trace period lookup was
 * an N+1 on the hot path (1000 lookups per batch). A set read at cycle
 * start may miss a close landing mid-cycle; that is SAFE: the post-close
 * reconciliation (audit B-1, parallel work package) mechanically
 * quarantine-flags any straggler the race lets through.
 */
export const closedMonthKeys = (periods: BillingPeriodModel[]): Set<string> =>
  new Set(
    periods
      .filter((period) => period.status === 'closed')
      .map((period) => `${period.year}-${period.month}`),
  );

/**
 * audit B-3: per-trace isolation must not mask a store outage. ONE
 * failing trace is poison — dead-lettered, the batch continues, the
 * cursor advances (ingest_failures is the recovery trail). But a
 * non-trivial batch where EVERY trace fails is what a store outage looks
 * like from here — advancing would burn the source's ~49-day retention
 * behind a wall of dead letters. Mirror of the source-side all-poison
 * breaker (decision 79): halt loudly, without advancing.
 */
export const ALL_FAILED_BREAKER_MIN_TRACES = 10;

export const assertNotAllFailed = (attempted: number, failed: number): void => {
  if (attempted >= ALL_FAILED_BREAKER_MIN_TRACES && failed === attempted) {
    throw new Error(
      `Sync: all ${attempted} traces in this batch failed ingestion — this ` +
        'looks like a store outage, not per-trace poison (mirrors decision ' +
        '79). Halting WITHOUT advancing; the batch stays re-runnable and ' +
        'the ingest_failures records carry the details.',
    );
  }
};

/**
 * THE single ingestion path for one source trace — extracted so the
 * windowed sync and the continuous batch sync share it verbatim (one
 * store, one truth: two syncs must never diverge on stamping rules).
 */
export const ingestSourceTrace = async (
  deps: IngestDeps,
  trace: SourceTrace,
  /** Closed billing months as monthKeyOf keys — loaded once per cycle (audit C-7.3). */
  closedMonths: Set<string>,
): Promise<IngestOutcome> => {
  // The domain carries the model as a structured ref; the price table
  // stays keyed by the canonical string, recomposed via modelKey.
  const model = sourceModelRef(trace);

  // QA19: the stamp uses the price version effective on the TRACE's
  // date (startedAt), resolved as-of at write time — not the price at
  // sync time. A trace dated 31/07 synced on 01/08 keeps July's price.
  const effectivePrices: EffectivePrices = model
    ? await deps.priceVersionRepository.findEffectivePrices(
        modelKey(model),
        trace.startedAt,
      )
    : {};

  const stamp = stampTokens(trace.tokens, effectivePrices);

  // T6: a trace dated inside an already-CLOSED month is stored anyway
  // (invariant 6 — the archive keeps everything) but quarantined: its
  // bill is frozen in the snapshot, so it enters flagged, never billed.
  const quarantined = closedMonths.has(monthKeyOf(trace.startedAt));

  const stampedTrace = {
    ...mapToTrace(trace, stamp, new Date()),
    billingQuarantine: quarantined
      ? { reason: 'period_closed' as const, quarantinedAt: new Date() }
      : null,
  };

  // audit B-3 (Q8): one oversized conversation must not stall ingestion
  // forever against the store's document cap. Content is clipped to
  // markers; the flag + the dead-letter event keep it visible; tokens and
  // costs are untouched (they come from counts, not content).
  const guarded = truncateOversizedContent(
    stampedTrace,
    deps.estimateDocumentBytes,
  );

  if (guarded.truncated) {
    console.warn(
      `Sync: trace ${trace.traceId} content truncated at ingestion — ` +
        `estimated ${guarded.originalBytes} bytes exceeds the document cap ` +
        '(audit B-3/Q8); tokens and costs are unaffected.',
    );
    await deps.ingestFailureRepository.recordTruncation({
      traceId: trace.traceId,
      originalBytes: guarded.originalBytes,
      seenAt: new Date(),
    });
  }

  const result = await deps.traceRepository.insertIfAbsent(guarded.trace);

  if (result === 'inserted') {
    return {
      outcome: 'inserted',
      pendingPrice: stamp.pricingStatus === 'pending_price',
      quarantined,
      tokenDivergence: false,
    };
  }

  // audit B-4 residual (Q3 = log + metric only): when the skipped branch
  // reports the STORED total, compare it with what the source says now.
  // Divergence means the trace kept growing after we ingested it — made
  // visible here, never repaired here (a stamped trace is immutable,
  // invariant 1; a pending one is the reprocess sweep's business).
  const storedTokensTotal =
    typeof result === 'object' ? result.storedTokensTotal : undefined;
  const sourceTokensTotal = sumTokens(trace.tokens);
  const tokenDivergence =
    storedTokensTotal !== undefined && storedTokensTotal !== sourceTokensTotal;

  if (tokenDivergence) {
    console.warn(
      `Sync: trace ${trace.traceId} re-synced with divergent token totals — ` +
        `source now ${sourceTokensTotal}, stored ${storedTokensTotal} ` +
        '(audit B-4 residual, Q3: logged only; the stored stamp/counts are ' +
        'never mutated).',
    );
  }

  // Invariant 7: attribution (agent/metadata/model) stays mutable in OPEN
  // periods ONLY — a re-synced trace refreshes attribution, never the
  // stamp, and never anything inside a closed month (its bill is frozen;
  // corrections go through the audited reopen flow). A pending trace
  // whose model arrives here becomes stampable by the reprocess job
  // (as-of rule, // QA19 above).
  if (!quarantined) {
    await deps.traceRepository.updateAttribution(trace.traceId, {
      agent: trace.agent,
      model,
      domain: trace.domain,
      subdomain: trace.subdomain,
    });
  }

  return { outcome: 'skipped', pendingPrice: false, quarantined, tokenDivergence };
};
