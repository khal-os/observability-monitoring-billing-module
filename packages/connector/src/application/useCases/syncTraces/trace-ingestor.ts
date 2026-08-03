import { EffectivePrices } from '@khal/core/application/interfaces/price-version-repository.js';
import { PriceVersionRepository } from '@khal/core/application/interfaces/price-version-repository.js';
import { TraceRepository } from '@khal/core/application/interfaces/trace-repository.js';
import {
  EstimateDocumentBytes,
  IngestFailureKind,
  IngestFailureRepository,
} from '../../interfaces/ingest-failure-repository.js';
import { BillingPeriodRepository } from '@khal/core/application/interfaces/billing-period-repository.js';
import { SourceTrace } from '../../interfaces/trace-source-client.js';
import { BillingPeriodModel } from '@khal/core/domain/models/billing-period-model.js';
import { modelKey } from '@khal/core/domain/models/model-ref.js';
import { stampTokens } from '@khal/core/application/useCases/priceStamping/price-stamper.js';
import { closedMonthKeys, monthKeyOf } from '@khal/core/domain/models/month-key.js';
import { mapToTrace, sourceModelRef, sumTokens } from './trace-mapper.js';
import {
  UnstorableTraceError,
  truncateOversizedContent,
} from './content-size-guard.js';

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
  /**
   * Read ONLY on the rare past-month path (see the freshness double-check
   * below) — the hot path is served by the cycle's closed-months set.
   */
  billingPeriodRepository: BillingPeriodRepository;
  ingestFailureRepository: IngestFailureRepository;
  estimateDocumentBytes: EstimateDocumentBytes;
}

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
 * re-audit 2026-08 (sync item 2): counting is not enough. The all-fail
 * breaker above protects a BACKLOG drain (full batches); a caught-up
 * worker processes 1–9-trace batches forever, so a SYSTEMIC write failure
 * — a stepped-down primary, lost transaction capability, a corrupted
 * counter document aborting every transaction — would dead-letter every
 * trace and advance the watermark for days, while the dead-letter write
 * itself keeps succeeding. Classify instead: an infra-class error is
 * never per-trace poison, so the loops RETHROW it (batch aborts, cursor
 * stays put) and only trace-shaped failures (document too large,
 * validation, money overflow) are dead-lettered. The ≥10 breaker stays as
 * the second net for anything this classifier does not name.
 *
 * Duck-typed on purpose: the application layer stays storage-blind
 * (decision 56) — no driver import, only the error SHAPES the driver
 * documents (name, code, error labels).
 *
 * The trade-off is deliberate: a contention-shaped abort (a write
 * conflict carrying TransientTransactionError) costs one aborted batch
 * and a retry instead of a dead letter. The worker's backoff owns that;
 * a wrongly parked trace is a hole in the archive nobody notices.
 */
const SYSTEMIC_STORE_ERROR_NAMES = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoServerSelectionError',
  'MongoNotConnectedError',
]);

/**
 * The driver's own retryable-error codes, by name:
 * HostUnreachable 6 · HostNotFound 7 · NetworkTimeout 89 ·
 * ShutdownInProgress 91 · PrimarySteppedDown 189 · SocketException 9001 ·
 * NotWritablePrimary 10107 · InterruptedAtShutdown 11600 ·
 * InterruptedDueToReplStateChange 11602 · NotPrimaryNoSecondaryOk 13435 ·
 * NotPrimaryOrSecondary 13436. ExceededTimeLimit (262) is deliberately
 * ABSENT — a per-operation time limit can be trace-shaped (one enormous
 * document), and that trace must stay dead-letterable.
 */
const SYSTEMIC_STORE_ERROR_CODES = new Set([
  6, 7, 89, 91, 189, 9001, 10107, 11600, 11602, 13435, 13436,
]);

/** Transaction labels the driver attaches when the FAILURE is the store, not the write. */
const SYSTEMIC_TRANSACTION_LABELS = [
  'TransientTransactionError',
  'UnknownTransactionCommitResult',
];

export const isSystemicStoreError = (error: unknown): boolean => {
  const candidate = error as
    | {
        name?: unknown;
        code?: unknown;
        hasErrorLabel?: (label: string) => boolean;
      }
    | null
    | undefined;

  if (!candidate) {
    return false;
  }

  if (
    typeof candidate.name === 'string' &&
    SYSTEMIC_STORE_ERROR_NAMES.has(candidate.name)
  ) {
    return true;
  }

  if (
    typeof candidate.hasErrorLabel === 'function' &&
    SYSTEMIC_TRANSACTION_LABELS.some((label) =>
      candidate.hasErrorLabel?.call(candidate, label),
    )
  ) {
    return true;
  }

  return (
    typeof candidate.code === 'number' &&
    SYSTEMIC_STORE_ERROR_CODES.has(candidate.code)
  );
};

/**
 * The honest dead-letter kind for a failure the loops are about to
 * record — shared so the windowed and continuous syncs can never disagree
 * about what a parked trace means (see IngestFailureKind).
 */
export const ingestFailureKindOf = (error: unknown): IngestFailureKind =>
  error instanceof UnstorableTraceError
    ? 'oversized_unstorable'
    : 'ingest_failure';

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

  const ingestedAt = new Date();
  const traceMonth = monthKeyOf(trace.startedAt);

  // T6: a trace dated inside an already-CLOSED month is stored anyway
  // (invariant 6 — the archive keeps everything) but quarantined: its
  // bill is frozen in the snapshot, so it enters flagged, never billed.
  let quarantined = closedMonths.has(traceMonth);

  // re-audit 2026-08 (sync item 5): freshness double-check for the ONE
  // case the cycle's set can get wrong in a damaging way — a trace dated
  // in a PAST month that the (possibly hours-old) set still calls open.
  // That is the straggler shape: it would enter unflagged into a month
  // whose bill is already frozen. C-7.3's N+1 concern does not apply
  // here — past-month traces are the rare path (late arrivals and
  // backfills), never the steady-state stream, which is same-month and
  // pays no lookup at all.
  if (!quarantined && traceMonth !== monthKeyOf(ingestedAt)) {
    const period = await deps.billingPeriodRepository.find(
      trace.startedAt.getUTCFullYear(),
      trace.startedAt.getUTCMonth() + 1,
    );

    quarantined = period?.status === 'closed';
  }

  const stampedTrace = {
    ...mapToTrace(trace, stamp, ingestedAt),
    billingQuarantine: quarantined
      ? { reason: 'period_closed' as const, quarantinedAt: ingestedAt }
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

  // re-audit 2026-08 (sync item 4): clipping every content field was not
  // enough — this document has no storable form. Fail LOUD and typed: the
  // loops dead-letter it under its own kind ('oversized_unstorable') and
  // count it as failed. No truncation record: nothing was stored, and a
  // truncation row means "stored, clipped".
  if (guarded.truncated && guarded.unstorable) {
    throw new UnstorableTraceError(trace.traceId, guarded.originalBytes);
  }

  const result = await deps.traceRepository.insertIfAbsent(guarded.trace);

  // re-audit 2026-08 (sync item 4): recorded only AFTER the store call
  // returned — the trace IS in the archive (written now, or already there
  // from an earlier cycle; the upsert is idempotent and repairs a crash
  // between the two writes). Recording it before the insert described a
  // store that might never have happened.
  if (guarded.truncated) {
    console.warn(
      `Sync: trace ${trace.traceId} content truncated at ingestion — ` +
        `estimated ${guarded.originalBytes} bytes exceeds the document cap ` +
        '(audit B-3/Q8); tokens and costs are unaffected.',
    );
    await deps.ingestFailureRepository.recordTruncation({
      traceId: trace.traceId,
      originalBytes: guarded.originalBytes,
      seenAt: ingestedAt,
    });
  }

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
