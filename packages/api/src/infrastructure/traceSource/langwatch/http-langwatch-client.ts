import {
  TraceSourceClient,
  SourceTrace,
  SyncWindow,
} from '../../../data/interfaces/trace-source-client.js';
import {
  langWatchApiTraceSchema,
  langWatchSearchResponseSchema,
} from './langwatch-api-schema.js';
import { mapApiTrace } from './langwatch-api-mapper.js';

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
  private readonly fetchFn: FetchFn;

  constructor(args: {
    endpoint: string;
    apiKey: string;
    pageSize?: number;
    fetchFn?: FetchFn;
  }) {
    this.endpoint = args.endpoint.replace(/\/+$/, '');
    this.apiKey = args.apiKey;
    this.pageSize = args.pageSize ?? 100;
    this.fetchFn = args.fetchFn ?? fetch;
  }

  async fetchTraces(window: SyncWindow): Promise<SourceTrace[]> {
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
