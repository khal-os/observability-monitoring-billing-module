import { z } from 'zod';
import {
  Controller,
  GetBillingSummaryUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest, buildSuccess } from '../../helpers/http-helper.js';
import {
  parseQuery,
  yearMonthQueryShape,
} from '../../helpers/query-validation.js';
import { toBillingSummaryView } from './billing-view-model.js';
import { BillingPeriodStateError } from '../../../domain/useCases/close-billing-period-use-case.js';

/** Strict (C-3): an unknown param is a 400, never silently ignored. */
const summaryQuerySchema = z.strictObject(yearMonthQueryShape);

export class GetBillingSummaryController implements Controller {
  private readonly getBillingSummary: GetBillingSummaryUseCase;

  constructor(args: { getBillingSummary: GetBillingSummaryUseCase }) {
    this.getBillingSummary = args.getBillingSummary;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(summaryQuerySchema, httpRequest.query);

    if (!parsed.ok) return parsed.response;

    try {
      const summary = await this.getBillingSummary.get(
        parsed.value.year,
        parsed.value.month,
      );

      return buildSuccess(toBillingSummaryView(summary));
    } catch (error) {
      // audit B-10.3: a period-state rejection (e.g. a FUTURE month —
      // nothing legitimate queries the future) is the caller's mistake:
      // 400 with the domain message, never a 500.
      if (error instanceof BillingPeriodStateError) {
        return buildBadRequest(error);
      }

      throw error;
    }
  }
}
