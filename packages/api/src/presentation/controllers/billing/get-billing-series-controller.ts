import {
  Controller,
  GetBillingSeriesUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError } from '../../errors/index.js';
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

export class GetBillingSeriesController implements Controller {
  private readonly getBillingSeries: GetBillingSeriesUseCase;

  constructor(args: { getBillingSeries: GetBillingSeriesUseCase }) {
    this.getBillingSeries = args.getBillingSeries;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const query = (httpRequest.query ?? {}) as {
      granularity?: string;
      months?: string;
      days?: string;
    };

    const granularity = query.granularity ?? 'month';

    if (granularity !== 'month' && granularity !== 'day') {
      return buildBadRequest(new InvalidParamError('granularity'));
    }

    if (granularity === 'day') {
      let days = DEFAULT_DAYS;

      if (query.days !== undefined) {
        days = Number(query.days);

        if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
          return buildBadRequest(new InvalidParamError('days'));
        }
      }

      return buildSuccess(
        toBillingDailySeriesView(await this.getBillingSeries.listDaily(days)),
      );
    }

    let months = DEFAULT_MONTHS;

    if (query.months !== undefined) {
      months = Number(query.months);

      if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) {
        return buildBadRequest(new InvalidParamError('months'));
      }
    }

    const series = await this.getBillingSeries.list(months);

    return buildSuccess(toBillingSeriesView(series));
  }
}
