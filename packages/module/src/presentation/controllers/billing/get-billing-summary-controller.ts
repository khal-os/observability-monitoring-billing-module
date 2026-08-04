import { z } from 'zod';
import {
  Controller,
  GetBillingSummaryUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildBadRequest, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError } from '../../errors/index.js';
import {
  parseQuery,
  yearMonthQueryShape,
} from '../../helpers/query-validation.js';
import { toBillingSummaryView } from './billing-view-model.js';
import { BillingPeriodStateError } from '@observability/core/domain/useCases/close-billing-period-use-case.js';

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

      const view = toBillingSummaryView(summary);

      // audit D-7: a CLOSED month is immutable (invariant 8 — served from
      // its frozen snapshot) and is the one response that may say so. The
      // ETag carries the snapshot version, so a reopen → re-close (which
      // bumps it) naturally invalidates caches. Open/current months keep
      // the middleware's no-store default.
      if (view.final && view.snapshot_version !== null) {
        return {
          ...buildSuccess(view),
          headers: {
            'cache-control': 'private, max-age=86400, immutable',
            etag: `"billing-${view.year}-${view.month}-v${view.snapshot_version}"`,
          },
        };
      }

      return buildSuccess(view);
    } catch (error) {
      // audit B-10.3: a period-state rejection (e.g. a FUTURE month —
      // nothing legitimate queries the future) is the caller's mistake:
      // 400 with the domain message, never a 500.
      //
      // Re-audit: the DOMAIN error must not travel as the body. It is a
      // plain Error, so `res.json` serialized own-enumerable properties
      // only — `{"name":"BillingPeriodStateError"}`, no `msg` (the
      // structural {name, msg} contract ApiError exists to guarantee,
      // and the strict apiErrorSchema the 400s document) plus an internal
      // class name on the wire. Re-wrapped as the house InvalidParamError
      // (the offending param IS the month), KEEPING the domain's
      // explanation as the message.
      if (error instanceof BillingPeriodStateError) {
        return buildBadRequest(new InvalidParamError('month', error.message));
      }

      throw error;
    }
  }
}
