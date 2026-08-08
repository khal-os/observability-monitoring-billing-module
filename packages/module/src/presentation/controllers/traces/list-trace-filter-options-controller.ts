import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListTraceFilterOptionsUseCase,
  TraceFilterOption,
} from './traces-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import {
  invalidPeriod,
  invalidPeriodResponse,
  parseQuery,
} from '../../helpers/query-validation.js';
import {
  toTraceListFilters,
  traceFilterQueryShape,
} from './trace-filter-query.js';

// Strict: an unknown param (e.g. a typo like ?agents=x) is a 400, never
// silently ignored into an unfiltered result.
const querySchema = z.strictObject(traceFilterQueryShape);

const toOptionViews = (options: TraceFilterOption[]) =>
  options.map(({ value, count }) => ({ value, count }));

export class ListTraceFilterOptionsController implements Controller {
  private readonly listTraceFilterOptions: ListTraceFilterOptionsUseCase;

  constructor(args: { listTraceFilterOptions: ListTraceFilterOptionsUseCase }) {
    this.listTraceFilterOptions = args.listTraceFilterOptions;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    if (invalidPeriod(parsed.value)) {
      return invalidPeriodResponse();
    }

    const options = await this.listTraceFilterOptions.list(
      toTraceListFilters(parsed.value),
    );

    // Explicit whitelist (invariant 4) — traceFilterOptionsResponseSchema.
    return buildSuccess({
      domains: toOptionViews(options.domains),
      subdomains: toOptionViews(options.subdomains),
      types: toOptionViews(options.types),
      agents: toOptionViews(options.agents),
      channels: toOptionViews(options.channels),
      statuses: toOptionViews(options.statuses),
    });
  }
}
