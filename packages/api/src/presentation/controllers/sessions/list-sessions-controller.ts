import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListSessionsUseCase,
} from './sessions-protocols.js';
import { buildSuccess, totalPages } from '../../helpers/http-helper.js';
import { paginationSchema, parseQuery } from '../../helpers/query-validation.js';
import { toSessionListItem } from './session-view-model.js';

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  agent: z.string().min(1).optional(),
  status: z.enum(['ok', 'error']).optional(),
  ...paginationSchema,
});

export class ListSessionsController implements Controller {
  private readonly listSessions: ListSessionsUseCase;

  constructor(args: { listSessions: ListSessionsUseCase }) {
    this.listSessions = args.listSessions;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    const { page, page_size, agent, from, to, status } = parsed.value;

    const result = await this.listSessions.list(
      { from, to, agentId: agent, status },
      { page, pageSize: page_size },
    );

    const now = new Date();

    return buildSuccess({
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      total_pages: totalPages(result.total, result.pageSize),
      items: result.items.map((session) => toSessionListItem(session, now)),
    });
  }
}
