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
import { PoisonRowRepository } from '../../../../application/interfaces/poison-row-repository.js';
import {
  SalvageableTokenField,
  SpanRow,
  SummaryRow,
  parseSummaryRow,
  spanRowSchema,
} from './clickhouse-row-schema.js';
import {
  mapSummaryTrace,
  unreconstructedTokenFields,
} from './clickhouse-row-mapper.js';
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

/**
 * Internal page size for the windowed backfill (audit C-6.3): bounds
 * memory to one page of summaries + spans + content, whatever the window
 * size — a 49-day onboarding backfill used to buffer everything and OOM
 * before the first insert. Matches the continuous loop's default batch.
 */
export const WINDOW_PAGE_SIZE = 1000;

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
 * A summary row that passed the boundary, carried alongside the raw row it
 * came from: the salvage decision below needs BOTH the counts the schema
 * nulled and the untouched raw row (forensics for the durable record).
 */
interface ParsedSummary {
  row: SummaryRow;
  nulledTokenFields: SalvageableTokenField[];
  raw: unknown;
}

/**
 * decision 59 — LangWatch source read straight from its ClickHouse store
 * (same compose network) instead of the HTTP API: the search API returns
 * at most the newest ~100 traces per window and spans only via an N+1
 * detail GET, which does not survive real volume. Implements BOTH ports:
 * cursor-paged batches for the continuous worker (TraceBatchSource) and
 * the paged half-open window contract (TraceSourceClient) so `make sync`
 * keeps working unchanged.
 *
 * Rows that fail validation/mapping are POISON: skipped, logged with
 * their id AND persisted to the poison_rows collection (audit C-6.2 —
 * container logs rotate; the durable record is the recovery trail), never
 * fatal, and the cursor advances past them (decision 62 — one bad row
 * must not stall ingestion). Summary rows whose ONLY defect is a bad
 * token count MAY be salvaged instead — but only when the span-level
 * usage sums rebuild every corrupt count (see toSourceTraces; every
 * salvage leaves its own durable `summary_salvaged` record). EXCEPT when a
 * whole non-trivial batch is poison (decision 79): that is
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
  private readonly poisonRowRepository?: PoisonRowRepository;

  constructor(args: {
    url: string;
    username: string;
    password: string;
    database: string;
    /** LangWatch project id — filters rows when the instance hosts more than one project. */
    tenantId?: string;
    /** Windowed-sync clamp (decision 61) — defaults to 15 min. */
    quietPeriodMs?: number;
    /** audit C-6.2: durable poison trail — optional so tests/fixtures stay log-only. */
    poisonRowRepository?: PoisonRowRepository;
    /** Test seam, like the HTTP client's fetchFn. */
    queryFn?: QueryFn;
  }) {
    this.tenantId = args.tenantId;
    this.quietPeriodMs = args.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.poisonRowRepository = args.poisonRowRepository;
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

  /**
   * The SOURCE's clock (audit C-6.4): the quiet period is measured on
   * UpdatedAt — the source's write times — so it must be anchored to the
   * source's clock, not the worker's. One cheap SELECT per cycle.
   */
  async sourceNow(): Promise<Date> {
    const rows = await this.queryFn(
      'SELECT toUnixTimestamp64Milli(now64(3)) AS nowMs',
      {},
    );

    const nowMs = Number((rows[0] as { nowMs?: unknown })?.nowMs);

    if (!Number.isFinite(nowMs)) {
      throw new Error(
        'Sync: ClickHouse clock read (now64) returned no usable value — ' +
          'refusing to guess the quiet-period ceiling (audit C-6.4).',
      );
    }

    return new Date(nowMs);
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

    const context = args.after
      ? `cursor=(${args.after.updatedAt.toISOString()}, ${args.after.traceId})`
      : 'cursor=start';
    const traces = await this.toSourceTraces(rows, context);

    assertNotAllPoison(rows.length, traces.length);

    return {
      traces,
      nextCursor: nextCursorOf(rows),
      scanned: rows.length,
    };
  }

  /**
   * Half-open [from, to) on the trace's own start instant — CLI contract,
   * served in bounded pages (audit C-6.3) keyed by the (OccurredAt,
   * TraceId) tuple cursor, the windowed twin of fetchBatch's machinery.
   */
  async *fetchTracesPaged(
    requestedWindow: SyncWindow,
  ): AsyncIterable<SourceTrace[]> {
    // Same quiet period as the continuous loop (decision 61): an in-flight
    // trace ingested mid-build freezes a partial, immutable stamp. The
    // clock is the SOURCE's (audit C-6.4), same as the ceiling below.
    const now = await this.sourceNow();
    const safe = clampWindowToQuietPeriod(
      requestedWindow,
      this.quietPeriodMs,
      now,
    );

    if (!safe) {
      console.warn(
        'Sync: window entirely inside the quiet period — nothing fetched ' +
          '(decision 61: in-flight traces would freeze partial stamps).',
      );

      return;
    }

    if (safe.clamped) {
      console.warn(
        `Sync: window upper bound clamped to ${safe.window.to.toISOString()} ` +
          '(quiet period, decision 61) — re-run later to cover the rest.',
      );
    }

    // audit B-4: the quiet period must hold on the UPDATE axis too — a
    // trace STARTED long ago but still receiving spans (long agent run,
    // human-in-the-loop pause) passes the OccurredAt clamp and would be
    // stamped with partial tokens, immutably. Defer any row updated after
    // the ceiling; the warn tells the operator a later re-run may fetch
    // more (the deferred rows stay in the source).
    const updatedBefore = new Date(now.getTime() - this.quietPeriodMs);

    console.warn(
      `Sync: rows still updating after ${updatedBefore.toISOString()} are ` +
        'deferred (quiet period on the update axis, audit B-4) — re-run ' +
        'the window later to pick up traces that were still receiving spans.',
    );

    const window = safe.window;
    const context = `window=[${window.from.toISOString()}, ${window.to.toISOString()})`;
    let afterOccurredAtMs = 0;
    let afterTraceId = '';

    for (;;) {
      const rows = await this.queryFn(
        `${SUMMARY_SELECT}
  WHERE s.OccurredAt >= fromUnixTimestamp64Milli({fromMs:Int64})
    AND s.OccurredAt < fromUnixTimestamp64Milli({toMs:Int64})
    AND s.UpdatedAt < fromUnixTimestamp64Milli({updatedBeforeMs:Int64})
    AND (s.OccurredAt, s.TraceId) > (fromUnixTimestamp64Milli({afterOccurredAtMs:Int64}), {afterTraceId:String})
    ${this.tenantId ? 'AND s.TenantId = {tenantId:String}' : ''}
  ORDER BY s.OccurredAt ASC, s.TraceId ASC
  LIMIT {limit:UInt32}`,
        {
          fromMs: window.from.getTime(),
          toMs: window.to.getTime(),
          updatedBeforeMs: updatedBefore.getTime(),
          afterOccurredAtMs,
          afterTraceId,
          limit: WINDOW_PAGE_SIZE,
          ...(this.tenantId ? { tenantId: this.tenantId } : {}),
        },
      );

      if (rows.length === 0) {
        return;
      }

      const traces = await this.toSourceTraces(rows, context);

      assertNotAllPoison(rows.length, traces.length);

      if (traces.length > 0) {
        yield traces;
      }

      if (rows.length < WINDOW_PAGE_SIZE) {
        return;
      }

      const next = windowCursorOf(rows);

      if (!next) {
        // Unreachable past the all-poison breaker (a full page with no
        // representable row would have thrown) — defensive stop, never
        // an infinite re-read of the same page.
        return;
      }

      afterOccurredAtMs = next.occurredAtMs;
      afterTraceId = next.traceId;
    }
  }

  private async toSourceTraces(
    rawRows: unknown[],
    context: string,
  ): Promise<SourceTrace[]> {
    const summaries: ParsedSummary[] = [];

    for (const raw of rawRows) {
      const parsed = parseSummaryRow(raw);

      if (parsed.ok) {
        summaries.push({
          row: parsed.row,
          nulledTokenFields: parsed.nulledTokenFields,
          raw,
        });
        continue;
      }

      const rowId = String((raw as { traceId?: unknown })?.traceId ?? 'unknown');

      console.warn(
        `Sync: poison summary row skipped (traceId=${rowId}): ${parsed.error}`,
      );
      await this.poisonRowRepository?.record({
        kind: 'summary',
        id: rowId,
        context,
        error: parsed.error,
        seenAt: new Date(),
        rawRow: raw,
      });
    }

    if (summaries.length === 0) {
      return [];
    }

    const spansByTrace = await this.fetchSpans(
      summaries.map((summary) => summary.row.traceId),
      context,
    );

    const traces: SourceTrace[] = [];

    for (const { row, nulledTokenFields, raw } of summaries) {
      let trace: SourceTrace;

      try {
        trace = mapSummaryTrace(row, spansByTrace.get(row.traceId) ?? []);
      } catch (error) {
        console.warn(
          `Sync: poison trace skipped (traceId=${row.traceId}): ${String(error)}`,
        );
        await this.poisonRowRepository?.record({
          kind: 'summary',
          id: row.traceId,
          context,
          error: String(error),
          seenAt: new Date(),
          rawRow: raw,
        });
        continue;
      }

      if (
        nulledTokenFields.length > 0 &&
        !(await this.salvageIsSafe(trace, nulledTokenFields, raw, context))
      ) {
        continue;
      }

      traces.push(trace);
    }

    return traces;
  }

  /**
   * The second half of the C-6.2 salvage rule (audit iteration 1,
   * invariant 2). The schema nulled the corrupt counts; the trace may only
   * proceed if the span-level `gen_ai.usage.*` sums rebuilt EVERY one of
   * them. Otherwise the usage behind those counts is unknown and letting
   * the trace through stamps it — immutably — as if that usage were zero
   * (R$ 0,00 outright when nothing survives, a silently zero-priced type
   * on partial corruption), which no reprocess can ever undo.
   *
   * Either way the outcome is recorded durably at decision time: a safe
   * salvage as `summary_salvaged` (a console.warn is not a trail — C-6.2),
   * a refused one as ordinary poison. The row is then skipped and the
   * cursor advances past it like any other poison row (decision 62).
   */
  private async salvageIsSafe(
    trace: SourceTrace,
    nulledTokenFields: SalvageableTokenField[],
    raw: unknown,
    context: string,
  ): Promise<boolean> {
    const nulled = nulledTokenFields.join(', ');
    const unreconstructed = unreconstructedTokenFields(trace, nulledTokenFields);

    if (unreconstructed.length > 0) {
      const error =
        `invalid token counts (${nulled}) with no span-level usage to ` +
        `rebuild ${unreconstructed.join(', ')} — the real usage is unknown, ` +
        'so the trace is NOT salvaged: ingesting it would stamp that usage ' +
        'at R$ 0,00 immutably (invariant 2).';

      console.warn(
        `Sync: poison summary row skipped (traceId=${trace.traceId}): ${error}`,
      );
      await this.poisonRowRepository?.record({
        kind: 'summary',
        id: trace.traceId,
        context,
        error,
        seenAt: new Date(),
        rawRow: raw,
      });

      return false;
    }

    const note =
      `invalid token counts nulled (${nulled}) and rebuilt from the ` +
      'span-level usage sums; the trace proceeds with content preserved ' +
      '(audit C-6.2).';

    console.warn(`Sync: summary row salvaged (traceId=${trace.traceId}): ${note}`);
    await this.poisonRowRepository?.record({
      kind: 'summary_salvaged',
      id: trace.traceId,
      context,
      error: note,
      seenAt: new Date(),
      rawRow: raw,
    });

    return true;
  }

  private async fetchSpans(
    traceIds: string[],
    context: string,
  ): Promise<Map<string, SpanRow[]>> {
    const rows = await this.queryFn(SPANS_SELECT, { traceIds });
    const spansByTrace = new Map<string, SpanRow[]>();

    for (const raw of rows) {
      const parsed = spanRowSchema.safeParse(raw);

      if (!parsed.success) {
        const rowId = String((raw as { spanId?: unknown })?.spanId ?? 'unknown');

        console.warn(
          `Sync: poison span row skipped (spanId=${rowId}): ${parsed.error.message}`,
        );
        await this.poisonRowRepository?.record({
          kind: 'span',
          id: rowId,
          context,
          error: parsed.error.message,
          seenAt: new Date(),
          rawRow: raw,
        });
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
        'image changed, re-validate the SELECTs/mapper first (decision 59). ' +
        'The poison_rows records say which boundary rejected each row — a ' +
        'whole batch of refused salvages (corrupt token counts no span ' +
        'usage could rebuild) is an instrumentation defect at the source, ' +
        'not drift here.',
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

/**
 * Windowed twin of nextCursorOf (audit C-6.3): the page cursor rides
 * (OccurredAt, TraceId) — the window's ORDER BY axis — with the same
 * poison-tolerant backwards scan.
 */
const windowCursorOf = (
  rawRows: unknown[],
): { occurredAtMs: number; traceId: string } | null => {
  for (let i = rawRows.length - 1; i >= 0; i -= 1) {
    const row = rawRows[i] as { occurredAtMs?: unknown; traceId?: unknown };
    const occurredAtMs = Number(row?.occurredAtMs);

    if (Number.isFinite(occurredAtMs) && typeof row.traceId === 'string') {
      return { occurredAtMs, traceId: row.traceId };
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
