import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListTraceFilterOptionsUseCase,
} from './traces-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { parseQuery } from '../../helpers/query-validation.js';
import {
  toTraceListFilters,
  traceFilterQueryShape,
} from './trace-filter-query.js';

const querySchema = z.object(traceFilterQueryShape);

export class ListTraceFilterOptionsController implements Controller {
  private readonly listTraceFilterOptions: ListTraceFilterOptionsUseCase;

  constructor(args: {
    listTraceFilterOptions: ListTraceFilterOptionsUseCase;
  }) {
    this.listTraceFilterOptions = args.listTraceFilterOptions;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    const options = await this.listTraceFilterOptions.list(
      toTraceListFilters(parsed.value),
    );

    // Explicit whitelist (invariant 4) — traceFilterOptionsResponseSchema.
    return buildSuccess({
      domains: options.domains,
      subdomains: options.subdomains,
      types: options.types,
      agents: options.agents,
      channels: options.channels,
    });
  }
}
