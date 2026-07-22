import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListTracesUseCase,
} from './traces-protocols.js';
import { buildSuccess, totalPages } from '../../helpers/http-helper.js';
import { paginationSchema, parseQuery } from '../../helpers/query-validation.js';
import { toTraceListItem } from './trace-view-model.js';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  agent: z.string().min(1).optional(),
  status: z.enum(['ok', 'error']).optional(),
  type: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  subdomain: z.string().min(1).optional(),
  search: z.string().min(1).optional(),
  ...paginationSchema,
});

export class ListTracesController implements Controller {
  private readonly listTraces: ListTracesUseCase;

  constructor(args: { listTraces: ListTracesUseCase }) {
    this.listTraces = args.listTraces;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    const { page, page_size, agent, ...filters } = parsed.value;

    const result = await this.listTraces.list(
      {
        from: filters.from,
        to: filters.to,
        agentId: agent,
        status: filters.status,
        type: filters.type,
        channel: filters.channel,
        domain: filters.domain,
        subdomain: filters.subdomain,
        search: filters.search,
      },
      { page, pageSize: page_size },
    );

    const now = new Date();

    return buildSuccess({
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      total_pages: totalPages(result.total, result.pageSize),
      items: result.items.map((trace) => toTraceListItem(trace, now)),
    });
  }
}
