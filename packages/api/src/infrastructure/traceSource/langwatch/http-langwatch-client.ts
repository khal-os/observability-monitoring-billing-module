import {
  TraceSourceClient,
  SourceTrace,
  SyncWindow,
} from '../../../application/interfaces/trace-source-client.js';
import { PoisonRowRepository } from '../../../application/interfaces/poison-row-repository.js';
import {
  langWatchApiTraceSchema,
  langWatchSearchResponseSchema,
} from './langwatch-api-schema.js';
import { mapApiTrace } from './langwatch-api-mapper.js';
import {
  DEFAULT_QUIET_PERIOD_MS,
  clampWindowToQuietPeriod,
} from './quiet-period.js';

export type FetchFn = typeof fetch;

/**
 * audit C-6.1: undici's defaults let a dead socket hang for minutes —
 * every request gets a hard ceiling instead.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Mirror of the ClickHouse client's all-poison breaker threshold
 * (decisions 62/79): below it, isolated malformed details are skipped and
 * recorded; at or above it, an all-poison page reads as API drift.
 */
const POISON_BREAKER_MIN_ROWS = 10;

/**
 * Real LangWatch client (QA14 resolvido): consulta o
 * `POST /api/traces/search` e busca cada trace em
 * `GET /api/traces/{id}?format=json` — a busca devolve os spans vazios,
 * então o detalhe é obrigatório (N+1; aceitável no volume atual, revisar
 * com QA15/dimensionamento).
 *
 * QA14 (verificado no langwatch:3.5.0): o search IGNORA pageOffset — a
 * única página alcançável é a primeira; o contrato real deste caminho é
 * UMA página + o cap guard (audit C-6.1 removeu o loop de paginação morto
 * que nunca executava uma segunda volta). Janelas maiores que pageSize
 * usam a fonte ClickHouse.
 *
 * Mantém a semântica de janela half-open [from, to) do contrato aplicando
 * o filtro localmente por cima do startDate/endDate do servidor.
 */
export class HttpLangWatchClient implements TraceSourceClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly pageSize: number;
  private readonly quietPeriodMs: number;
  private readonly fetchFn: FetchFn;
  private readonly poisonRowRepository?: PoisonRowRepository;

  constructor(args: {
    endpoint: string;
    apiKey: string;
    pageSize?: number;
    quietPeriodMs?: number;
    /** audit C-6.2: durable poison trail — optional so tests stay log-only. */
    poisonRowRepository?: PoisonRowRepository;
    fetchFn?: FetchFn;
  }) {
    this.endpoint = args.endpoint.replace(/\/+$/, '');
    this.apiKey = args.apiKey;
    this.pageSize = args.pageSize ?? 100;
    this.quietPeriodMs = args.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.poisonRowRepository = args.poisonRowRepository;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  /** Single capped page (QA14) yielded once — the paged contract's degenerate form. */
  async *fetchTracesPaged(
    requestedWindow: SyncWindow,
  ): AsyncIterable<SourceTrace[]> {
    const safe = clampWindowToQuietPeriod(requestedWindow, this.quietPeriodMs);

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

    const window = safe.window;

    const page = langWatchSearchResponseSchema.parse(
      await this.request('POST', '/api/traces/search', {
        pageSize: this.pageSize,
        pageOffset: 0,
        startDate: window.from.getTime(),
        endDate: window.to.getTime(),
      }),
    );

    // QA14 (verified on langwatch:3.5.0): the search endpoint IGNORES
    // pageOffset — every "page" returns the same newest slice. A window
    // holding more hits than one page can therefore NEVER be fetched
    // completely on this path, and the excess would be silently lost
    // (LangWatch expires at ~49 days). Fail LOUD.
    const claimedHits = page.pagination?.totalHits;

    if (claimedHits !== undefined && claimedHits > page.traces.length) {
      throw new Error(
        `LangWatch search window holds ${claimedHits} traces but one page ` +
          `carries ${page.traces.length} (QA14: pageOffset is ignored — the ` +
          'excess is unreachable on the HTTP path). Narrow the window to ' +
          `at most ${this.pageSize} traces or use the direct-ClickHouse ` +
          'source (LANGWATCH_CLICKHOUSE_URL).',
      );
    }

    // audit C-6.1: `pagination` is optional in the schema — a FULL page
    // without totalHits is indistinguishable from a capped window, so the
    // guard above cannot see the excess. Proceeding would be exactly the
    // silent partial sync it exists to prevent. Fail loud instead.
    if (claimedHits === undefined && page.traces.length === this.pageSize) {
      throw new Error(
        `LangWatch search returned a full page (${this.pageSize} traces) ` +
          'without pagination.totalHits — cannot prove the window fits one ' +
          'page (QA14 cap guard). Narrow the window or use the ' +
          'direct-ClickHouse source (LANGWATCH_CLICKHOUSE_URL).',
      );
    }

    const context = `window=[${window.from.toISOString()}, ${window.to.toISOString()})`;
    const traces: SourceTrace[] = [];
    let poisonDetails = 0;

    for (const item of page.traces) {
      const raw = await this.request(
        'GET',
        `/api/traces/${encodeURIComponent(item.trace_id)}?format=json`,
      );

      // audit C-6.1: one malformed N+1 detail must not throw away the
      // whole run — skip, log, and record (decision 62, durable per C-6.2).
      const detail = langWatchApiTraceSchema.safeParse(raw);

      if (!detail.success) {
        poisonDetails += 1;
        console.warn(
          `Sync: poison trace detail skipped (traceId=${item.trace_id}): ${detail.error.message}`,
        );
        await this.poisonRowRepository?.record({
          kind: 'http-detail',
          id: item.trace_id,
          context,
          error: detail.error.message,
          seenAt: new Date(),
          rawRow: raw,
        });
        continue;
      }

      try {
        const mapped = mapApiTrace(detail.data);

        if (mapped.startedAt >= window.from && mapped.startedAt < window.to) {
          traces.push(mapped);
        }
      } catch (error) {
        poisonDetails += 1;
        console.warn(
          `Sync: poison trace detail skipped (traceId=${item.trace_id}): ${String(error)}`,
        );
        await this.poisonRowRepository?.record({
          kind: 'http-detail',
          id: item.trace_id,
          context,
          error: String(error),
          seenAt: new Date(),
          rawRow: raw,
        });
      }
    }

    // All-poison breaker, mirroring the ClickHouse path (decisions 62/79):
    // a page where EVERY detail fails validation is API/schema drift, not
    // isolated bad rows — fail loud instead of reporting a healthy empty
    // sync while the cursorless window silently loses everything.
    if (
      page.traces.length >= POISON_BREAKER_MIN_ROWS &&
      poisonDetails === page.traces.length
    ) {
      throw new Error(
        `Sync: all ${page.traces.length} trace details in this page failed ` +
          'validation — this looks like LangWatch API drift, not isolated ' +
          'poison rows. Halting (decision 79); the poison_rows records ' +
          'carry the details.',
      );
    }

    if (traces.length > 0) {
      yield traces;
    }
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const attempt = (): ReturnType<FetchFn> =>
      this.fetchFn(`${this.endpoint}${path}`, {
        method,
        headers: {
          'X-Auth-Token': this.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // audit C-6.1: hard timeout on every request.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

    let response: Awaited<ReturnType<FetchFn>>;

    try {
      response = await attempt();

      if (!response.ok && response.status >= 500 && method === 'GET') {
        // audit C-6.1: one retry for idempotent GETs on server errors.
        response = await attempt();
      }
    } catch (error) {
      if (method !== 'GET') {
        // The POST search is not retried — the caller re-runs the window.
        throw error;
      }

      // audit C-6.1: one retry for idempotent GETs on timeout/network.
      response = await attempt();
    }

    if (!response.ok) {
      throw new Error(
        `LangWatch API: ${method} ${path} failed with HTTP ${response.status}`,
      );
    }

    return response.json();
  }
}
