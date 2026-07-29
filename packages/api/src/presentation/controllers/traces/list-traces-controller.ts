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
import {
  toTraceListFilters,
  traceFilterQueryShape,
} from './trace-filter-query.js';

const querySchema = z.object({
  ...traceFilterQueryShape,
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

    const { page, page_size, ...filterQuery } = parsed.value;

    const result = await this.listTraces.list(toTraceListFilters(filterQuery), {
      page,
      pageSize: page_size,
    });

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
