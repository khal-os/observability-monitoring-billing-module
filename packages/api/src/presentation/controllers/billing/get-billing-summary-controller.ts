import {
  Controller,
  GetBillingSummaryUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError, MissingParamError } from '../../errors/index.js';
import { toBillingSummaryView } from './billing-view-model.js';

export class GetBillingSummaryController implements Controller {
  private readonly getBillingSummary: GetBillingSummaryUseCase;

  constructor(args: { getBillingSummary: GetBillingSummaryUseCase }) {
    this.getBillingSummary = args.getBillingSummary;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const query = (httpRequest.query ?? {}) as {
      year?: string;
      month?: string;
    };

    for (const field of ['year', 'month'] as const) {
      if (!query[field]) {
        return buildBadRequest(new MissingParamError(field));
      }
    }

    const year = Number(query.year);
    const month = Number(query.month);

    if (!Number.isInteger(year) || year < 1970 || year > 9999) {
      return buildBadRequest(new InvalidParamError('year'));
    }

    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return buildBadRequest(new InvalidParamError('month'));
    }

    const summary = await this.getBillingSummary.get(year, month);

    return buildSuccess(toBillingSummaryView(summary));
  }
}
