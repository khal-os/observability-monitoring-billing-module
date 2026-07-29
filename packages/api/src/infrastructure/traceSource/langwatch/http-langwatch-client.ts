import {
  TraceSourceClient,
  SourceTrace,
  SyncWindow,
} from '../../../application/interfaces/trace-source-client.js';
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
 * Real LangWatch client (QA14 resolvido): pagina o
 * `POST /api/traces/search` (pageSize/pageOffset até `totalHits`) e busca
 * cada trace em `GET /api/traces/{id}?format=json` — a busca devolve os
 * spans vazios, então o detalhe é obrigatório (N+1; aceitável no volume
 * atual, revisar com QA15/dimensionamento).
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

  constructor(args: {
    endpoint: string;
    apiKey: string;
    pageSize?: number;
    quietPeriodMs?: number;
    fetchFn?: FetchFn;
  }) {
    this.endpoint = args.endpoint.replace(/\/+$/, '');
    this.apiKey = args.apiKey;
    this.pageSize = args.pageSize ?? 100;
    this.quietPeriodMs = args.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async fetchTraces(requestedWindow: SyncWindow): Promise<SourceTrace[]> {
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
    const traces: SourceTrace[] = [];
    let pageOffset = 0;

    for (;;) {
      const page = langWatchSearchResponseSchema.parse(
        await this.request('POST', '/api/traces/search', {
          pageSize: this.pageSize,
          pageOffset,
          startDate: window.from.getTime(),
          endDate: window.to.getTime(),
        }),
      );

      // QA14 (verified on langwatch:3.5.0): the search endpoint IGNORES
      // pageOffset — every "page" returns the same newest slice. A window
      // holding more hits than one page can therefore NEVER be fetched
      // completely on this path, and looping would report the duplicates
      // as a healthy "fetched N, skipped most" while everything older is
      // silently lost (and LangWatch expires at ~49 days). Fail LOUD.
      const claimedHits = page.pagination?.totalHits ?? page.traces.length;

      if (claimedHits > page.traces.length) {
        throw new Error(
          `LangWatch search window holds ${claimedHits} traces but one page ` +
            `carries ${page.traces.length} (QA14: pageOffset is ignored — the ` +
            'excess is unreachable on the HTTP path). Narrow the window to ' +
            `at most ${this.pageSize} traces or use the direct-ClickHouse ` +
            'source (LANGWATCH_CLICKHOUSE_URL).',
        );
      }

      for (const item of page.traces) {
        const detail = langWatchApiTraceSchema.parse(
          await this.request(
            'GET',
            `/api/traces/${encodeURIComponent(item.trace_id)}?format=json`,
          ),
        );

        const mapped = mapApiTrace(detail);

        if (mapped.startedAt >= window.from && mapped.startedAt < window.to) {
          traces.push(mapped);
        }
      }

      pageOffset += page.traces.length;

      const totalHits = page.pagination?.totalHits ?? pageOffset;

      if (page.traces.length === 0 || pageOffset >= totalHits) {
        break;
      }
    }

    return traces;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchFn(`${this.endpoint}${path}`, {
      method,
      headers: {
        'X-Auth-Token': this.apiKey,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(
        `LangWatch API: ${method} ${path} failed with HTTP ${response.status}`,
      );
    }

    return response.json();
  }
}
