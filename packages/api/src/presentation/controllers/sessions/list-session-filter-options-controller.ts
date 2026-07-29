import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListSessionFilterOptionsUseCase,
  SessionFilterOption,
} from './sessions-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import {
  invalidPeriod,
  invalidPeriodResponse,
  parseQuery,
} from '../../helpers/query-validation.js';
import {
  sessionFilterQueryShape,
  toSessionListFilters,
} from './session-filter-query.js';

// Strict: an unknown param (e.g. a typo like ?agents=x) is a 400, never
// silently ignored into an unfiltered result.
const querySchema = z.strictObject(sessionFilterQueryShape);

const toOptionViews = (options: SessionFilterOption[]) =>
  options.map(({ value, count }) => ({ value, count }));

export class ListSessionFilterOptionsController implements Controller {
  private readonly listSessionFilterOptions: ListSessionFilterOptionsUseCase;

  constructor(args: {
    listSessionFilterOptions: ListSessionFilterOptionsUseCase;
  }) {
    this.listSessionFilterOptions = args.listSessionFilterOptions;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(querySchema, httpRequest.query);

    if (!parsed.ok) {
      return parsed.response;
    }

    if (invalidPeriod(parsed.value)) {
      return invalidPeriodResponse();
    }

    const options = await this.listSessionFilterOptions.list(
      toSessionListFilters(parsed.value),
    );

    // Explicit whitelist (invariant 4) — sessionFilterOptionsResponseSchema.
    return buildSuccess({
      agents: toOptionViews(options.agents),
      statuses: toOptionViews(options.statuses),
    });
  }
}
