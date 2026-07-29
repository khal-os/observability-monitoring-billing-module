import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListSessionsUseCase,
} from './sessions-protocols.js';
import { buildSuccess, totalPages } from '../../helpers/http-helper.js';
import { formatIntDisplay } from '../../../common/helpers/display/display.js';
import {
  exceedsPaginationDepth,
  paginationDepthExceededResponse,
  paginationSchema,
  parseQuery,
} from '../../helpers/query-validation.js';
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

    if (exceedsPaginationDepth(parsed.value)) {
      return paginationDepthExceededResponse();
    }

    const { page, page_size, agent, from, to, status } = parsed.value;

    const result = await this.listSessions.list(
      { from, to, agentId: agent, status },
      { page, pageSize: page_size },
    );

    const now = new Date();
    const pages = totalPages(result.total, result.pageSize);
    // Capped counting (decision 77/79): totals stop at the cap and
    // displays carry the "+" so a capped total never reads as exact.
    const suffix = result.totalCapped ? '+' : '';

    return buildSuccess({
      page: result.page,
      page_size: result.pageSize,
      total: result.total,
      total_capped: result.totalCapped,
      total_display: `${formatIntDisplay(result.total)}${suffix}`,
      total_pages: pages,
      total_pages_display: `${formatIntDisplay(pages)}${suffix}`,
      items: result.items.map((session) => toSessionListItem(session, now)),
    });
  }
}
