import { createClient } from '@clickhouse/client';
import {
  SourceTrace,
  SyncWindow,
  TraceSourceClient,
} from '../../../../application/interfaces/trace-source-client.js';
import {
  SyncCursor,
  TraceBatch,
  TraceBatchSource,
} from '../../../../application/interfaces/trace-batch-source.js';
import {
  SpanRow,
  SummaryRow,
  spanRowSchema,
  summaryRowSchema,
} from './clickhouse-row-schema.js';
import { mapSummaryTrace } from './clickhouse-row-mapper.js';
import {
  DEFAULT_QUIET_PERIOD_MS,
  clampWindowToQuietPeriod,
} from '../quiet-period.js';

/**
 * The goose migration version of langwatch/langwatch:3.5.0 — the version
 * this client's SELECTs and mapper were validated against. Upgrading the
 * LangWatch image bumps this value in ClickHouse; the worker then refuses
 * to start (visibly, in a crash loop) instead of syncing through an
 * unverified schema. Re-validate the queries, then update this constant —
 * that IS the upgrade procedure (decision 59).
 */
export const EXPECTED_LANGWATCH_SCHEMA_VERSION = 35;

export type QueryFn = (
  query: string,
  params: Record<string, unknown>,
) => Promise<unknown[]>;

const SUMMARY_SELECT = `
  SELECT
    s.TraceId                                 AS traceId,
    toUnixTimestamp64Milli(s.OccurredAt)      AS occurredAtMs,
    toUnixTimestamp64Milli(s.UpdatedAt)       AS updatedAtMs,
    s.Attributes                              AS attributes,
    s.ComputedInput                           AS computedInput,
    s.ComputedOutput                          AS computedOutput,
    s.TotalDurationMs                         AS totalDurationMs,
    s.ContainsErrorStatus                     AS containsError,
    s.ErrorMessage                            AS errorMessage,
    s.TotalPromptTokenCount                   AS promptTokens,
    s.TotalCompletionTokenCount               AS completionTokens,
    s.RootSpanType                            AS rootSpanType
  FROM trace_summaries AS s FINAL`;

const SPANS_SELECT = `
  SELECT
    TraceId                                   AS traceId,
    SpanId                                    AS spanId,
    ParentSpanId                              AS parentSpanId,
    SpanName                                  AS name,
    toUnixTimestamp64Milli(StartTime)         AS startedAtMs,
    toUnixTimestamp64Milli(EndTime)           AS endedAtMs,
    StatusCode                                AS statusCode,
    StatusMessage                             AS statusMessage,
    mapUpdate(ResourceAttributes, SpanAttributes) AS attributes
  FROM stored_spans FINAL
  WHERE TraceId IN {traceIds:Array(String)}
  ORDER BY StartTime ASC, SpanId ASC`;

/**
 * decision 59 — LangWatch source read straight from its ClickHouse store
 * (same compose network) instead of the HTTP API: the search API returns
 * at most the newest ~100 traces per window and spans only via an N+1
 * detail GET, which does not survive real volume. Implements BOTH ports:
 * cursor-paged batches for the continuous worker (TraceBatchSource) and
 * the one-off half-open window contract (TraceSourceClient) so
 * `make sync` keeps working unchanged.
 *
 * Rows that fail validation/mapping are POISON: skipped and logged with
 * their id, never fatal, and the cursor advances past them (decision 62 —
 * one bad row must not stall ingestion; the log is the recovery trail).
 * EXCEPT when a whole non-trivial batch is poison (decision 79): that is
 * indistinguishable from schema drift (the startup tripwire runs once —
 * a LangWatch upgrade mid-run would otherwise convert 100% of traffic to
 * skipped-and-logged rows while the cursor advances past them, a silent
 * permanent archive hole). All-poison batches throw instead.
 */
export class ClickHouseLangWatchClient
  implements TraceSourceClient, TraceBatchSource
{
  private readonly tenantId?: string;
  private readonly quietPeriodMs: number;
  private readonly queryFn: QueryFn;

  constructor(args: {
    url: string;
    username: string;
    password: string;
    database: string;
    /** LangWatch project id — filters rows when the instance hosts more than one project. */
    tenantId?: string;
    /** Windowed-sync clamp (decision 61) — defaults to 15 min. */
    quietPeriodMs?: number;
    /** Test seam, like the HTTP client's fetchFn. */
    queryFn?: QueryFn;
  }) {
    this.tenantId = args.tenantId;
    this.quietPeriodMs = args.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.queryFn = args.queryFn ?? makeClickHouseQueryFn(args);
  }

  /**
   * The schema tripwire: refuses to operate on a LangWatch schema version
   * other than the one this code was validated against. Called by the
   * worker at startup — a mismatch is FATAL by design, never skipped.
   */
  async assertCompatibleSchema(): Promise<void> {
    const rows = await this.queryFn(
      'SELECT max(version_id) AS version FROM goose_db_version WHERE is_applied = 1',
      {},
    );

    const version = Number((rows[0] as { version?: unknown })?.version);

    if (version !== EXPECTED_LANGWATCH_SCHEMA_VERSION) {
      throw new Error(
        `LangWatch ClickHouse schema version ${version} does not match the ` +
          `validated version ${EXPECTED_LANGWATCH_SCHEMA_VERSION}. The ` +
          'LangWatch image changed under this client — re-validate the ' +
          'SELECTs/mapper against the new schema and update ' +
          'EXPECTED_LANGWATCH_SCHEMA_VERSION (see decision 59).',
      );
    }
  }

  async fetchBatch(args: {
    after: SyncCursor | null;
    limit: number;
    updatedBefore: Date;
  }): Promise<TraceBatch> {
    // Tuple comparison gives a total order over (UpdatedAt, TraceId) — the
    // tie-breaker matters because many rows share one millisecond.
    const rows = await this.queryFn(
      `${SUMMARY_SELECT}
  WHERE (s.UpdatedAt, s.TraceId) > (fromUnixTimestamp64Milli({afterUpdatedAtMs:Int64}), {afterTraceId:String})
    AND s.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})
    ${this.tenantId ? 'AND s.TenantId = {tenantId:String}' : ''}
  ORDER BY s.UpdatedAt ASC, s.TraceId ASC
  LIMIT {limit:UInt32}`,
      {
        afterUpdatedAtMs: args.after?.updatedAt.getTime() ?? 0,
        afterTraceId: args.after?.traceId ?? '',
        updatedBeforeMs: args.updatedBefore.getTime(),
        limit: args.limit,
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      },
    );

    const traces = await this.toSourceTraces(rows);

    assertNotAllPoison(rows.length, traces.length);

    return {
      traces,
      nextCursor: nextCursorOf(rows),
      scanned: rows.length,
    };
  }

  /** Half-open [from, to) on the trace's own start instant — CLI contract. */
  async fetchTraces(requestedWindow: SyncWindow): Promise<SourceTrace[]> {
    // Same quiet period as the continuous loop (decision 61): an in-flight
    // trace ingested mid-build freezes a partial, immutable stamp.
    const safe = clampWindowToQuietPeriod(requestedWindow, this.quietPeriodMs);

    if (!safe) {
      console.warn(
        'Sync: window entirely inside the quiet period — nothing fetched ' +
          '(decision 61: in-flight traces would freeze partial stamps).',
      );

      return [];
    }

    if (safe.clamped) {
      console.warn(
        `Sync: window upper bound clamped to ${safe.window.to.toISOString()} ` +
          '(quiet period, decision 61) — re-run later to cover the rest.',
      );
    }

    const window = safe.window;
    const rows = await this.queryFn(
      `${SUMMARY_SELECT}
  WHERE s.OccurredAt >= fromUnixTimestamp64Milli({fromMs:Int64})
    AND s.OccurredAt < fromUnixTimestamp64Milli({toMs:Int64})
    ${this.tenantId ? 'AND s.TenantId = {tenantId:String}' : ''}
  ORDER BY s.OccurredAt ASC, s.TraceId ASC`,
      {
        fromMs: window.from.getTime(),
        toMs: window.to.getTime(),
        ...(this.tenantId ? { tenantId: this.tenantId } : {}),
      },
    );

    const traces = await this.toSourceTraces(rows);

    assertNotAllPoison(rows.length, traces.length);

    return traces;
  }

  private async toSourceTraces(rawRows: unknown[]): Promise<SourceTrace[]> {
    const summaries: SummaryRow[] = [];

    for (const raw of rawRows) {
      const parsed = summaryRowSchema.safeParse(raw);

      if (parsed.success) {
        summaries.push(parsed.data);
        continue;
      }

      console.warn(
        `Sync: poison summary row skipped (traceId=${String(
          (raw as { traceId?: unknown })?.traceId ?? 'unknown',
        )}): ${parsed.error.message}`,
      );
    }

    if (summaries.length === 0) {
      return [];
    }

    const spansByTrace = await this.fetchSpans(
      summaries.map((summary) => summary.traceId),
    );

    const traces: SourceTrace[] = [];

    for (const summary of summaries) {
      try {
        traces.push(
          mapSummaryTrace(summary, spansByTrace.get(summary.traceId) ?? []),
        );
      } catch (error) {
        console.warn(
          `Sync: poison trace skipped (traceId=${summary.traceId}): ${String(error)}`,
        );
      }
    }

    return traces;
  }

  private async fetchSpans(
    traceIds: string[],
  ): Promise<Map<string, SpanRow[]>> {
    const rows = await this.queryFn(SPANS_SELECT, { traceIds });
    const spansByTrace = new Map<string, SpanRow[]>();

    for (const raw of rows) {
      const parsed = spanRowSchema.safeParse(raw);

      if (!parsed.success) {
        console.warn(
          `Sync: poison span row skipped (spanId=${String(
            (raw as { spanId?: unknown })?.spanId ?? 'unknown',
          )}): ${parsed.error.message}`,
        );
        continue;
      }

      const spans = spansByTrace.get(parsed.data.traceId) ?? [];

      spans.push(parsed.data);
      spansByTrace.set(parsed.data.traceId, spans);
    }

    return spansByTrace;
  }
}

/**
 * The poison circuit breaker (decision 79): decision 62's skip-and-log is
 * right for an ISOLATED malformed row, but a batch where EVERY row fails
 * validation/mapping is a different animal — that is what schema drift
 * looks like from here (the startup tripwire runs once; a LangWatch
 * upgrade mid-run is invisible to it), and advancing the cursor over it
 * silently loses the whole stream to rotating container logs. Below the
 * threshold, N independent malformed rows in sequence stays plausible and
 * the skip-and-advance behavior is preserved; at or above it, halt loudly
 * without advancing. Also closes the sleepless-poll corner: an all-poison
 * FULL batch used to yield nextCursor=null + caughtUp=false, re-fetching
 * the identical batch in a tight loop.
 */
const POISON_BREAKER_MIN_ROWS = 10;

const assertNotAllPoison = (rowCount: number, traceCount: number): void => {
  if (rowCount >= POISON_BREAKER_MIN_ROWS && traceCount === 0) {
    throw new Error(
      `Sync: all ${rowCount} rows in this batch failed validation/mapping — ` +
        'this looks like LangWatch schema drift, not isolated poison rows. ' +
        'Halting WITHOUT advancing the cursor (the rows stay fetchable). ' +
        'Restart the worker to re-run the schema tripwire; if the LangWatch ' +
        'image changed, re-validate the SELECTs/mapper first (decision 59).',
    );
  }
};

/**
 * The cursor advances over RAW rows — a poison row moves it forward like
 * any other, so it can never stall the loop. Raw field access is guarded:
 * a row too broken to even carry (updatedAtMs, traceId) is unrepresentable
 * in the cursor and simply skipped here (the batch still advances via the
 * later well-formed rows; an all-poison batch below the circuit-breaker
 * threshold keeps the cursor put, which only re-logs the same skips next
 * tick — safe, if noisy; at the threshold the breaker throws instead).
 */
const nextCursorOf = (rawRows: unknown[]): SyncCursor | null => {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    const row = rawRows[i] as { updatedAtMs?: unknown; traceId?: unknown };
    const updatedAtMs = Number(row?.updatedAtMs);

    if (Number.isFinite(updatedAtMs) && typeof row.traceId === 'string') {
      return { updatedAt: new Date(updatedAtMs), traceId: row.traceId };
    }
  }

  return null;
};

const makeClickHouseQueryFn = (args: {
  url: string;
  username: string;
  password: string;
  database: string;
}): QueryFn => {
  const client = createClient({
    url: args.url,
    username: args.username,
    password: args.password,
    database: args.database,
    application: 'platform-sync',
  });

  return async (query, params) => {
    const result = await client.query({
      query,
      query_params: params,
      format: 'JSONEachRow',
      clickhouse_settings: {
        // Int64 (our epoch-ms aliases) as JSON numbers, not strings —
        // epoch ms fits far below 2^53, so no precision is at risk.
        output_format_json_quote_64bit_integers: 0,
      },
    });

    return result.json();
  };
};
