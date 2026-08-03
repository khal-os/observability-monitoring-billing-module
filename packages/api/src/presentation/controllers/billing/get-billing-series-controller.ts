import { z } from 'zod';
import {
  Controller,
  GetBillingSeriesUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError } from '../../errors/index.js';
import { parseQuery } from '../../helpers/query-validation.js';
import {
  toBillingDailySeriesView,
  toBillingSeriesView,
} from './billing-view-model.js';

/** History caps: bound the payload, not the store (T8). */
const DEFAULT_MONTHS = 12;
const MAX_MONTHS = 24;
/** Daily lens (decision 97) — the prototype's 7/30/90 presets fit inside. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

/** Strict (C-3): an unknown param is a 400, never silently ignored. */
const seriesQuerySchema = z.strictObject({
  granularity: z.enum(['month', 'day']).default('month'),
  months: z.coerce.number().int().min(1).max(MAX_MONTHS).optional(),
  days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
});

export class GetBillingSeriesController implements Controller {
  private readonly getBillingSeries: GetBillingSeriesUseCase;

  constructor(args: { getBillingSeries: GetBillingSeriesUseCase }) {
    this.getBillingSeries = args.getBillingSeries;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(seriesQuerySchema, httpRequest.query);

    if (!parsed.ok) return parsed.response;

    const { granularity, months, days } = parsed.value;

    // Cross-field rule (documented behavior, now enforced): each window
    // param belongs to ITS granularity — `days` only with granularity=day,
    // `months` only with granularity=month. Silently ignoring the stray
    // param would answer a different window than the client asked for.
    if (granularity === 'day') {
      if (months !== undefined) {
        return buildBadRequest(new InvalidParamError('months'));
      }

      return buildSuccess(
        toBillingDailySeriesView(
          await this.getBillingSeries.listDaily(days ?? DEFAULT_DAYS),
        ),
      );
    }

    if (days !== undefined) {
      return buildBadRequest(new InvalidParamError('days'));
    }

    const series = await this.getBillingSeries.list(months ?? DEFAULT_MONTHS);

    return buildSuccess(toBillingSeriesView(series));
  }
}
