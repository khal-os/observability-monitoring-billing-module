import { z } from 'zod';
import {
  Controller,
  GetTraceDetailUseCase,
  HttpRequest,
  HttpResponse,
} from './traces-protocols.js';
import { buildBadRequest, buildNotFound, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';
import { parseQuery } from '../../helpers/query-validation.js';
import { toTraceDetail } from './trace-view-model.js';

/**
 * The detail takes no query params — the empty strict schema makes that a
 * contract (C-3): any param is a 400, never silently ignored.
 */
const detailQuerySchema = z.strictObject({});

export class GetTraceDetailController implements Controller {
  private readonly getTraceDetail: GetTraceDetailUseCase;

  constructor(args: { getTraceDetail: GetTraceDetailUseCase }) {
    this.getTraceDetail = args.getTraceDetail;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const traceId = (httpRequest.params as { id?: string } | undefined)?.id;

    if (!traceId) {
      return buildBadRequest(new InvalidParamError('id'));
    }

    const parsedQuery = parseQuery(detailQuerySchema, httpRequest.query);

    if (!parsedQuery.ok) return parsedQuery.response;

    const detail = await this.getTraceDetail.get(traceId);

    if (!detail) {
      return buildNotFound(new NotFoundError(`trace ${traceId}`));
    }

    return buildSuccess(toTraceDetail(detail, new Date()));
  }
}
