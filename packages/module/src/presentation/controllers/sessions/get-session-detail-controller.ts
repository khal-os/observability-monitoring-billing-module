import { z } from 'zod';
import {
  Controller,
  GetSessionDetailUseCase,
  HttpRequest,
  HttpResponse,
} from './sessions-protocols.js';
import { buildBadRequest, buildNotFound, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';
import { parseQuery } from '../../helpers/query-validation.js';
import { toSessionDetail } from './session-view-model.js';

/**
 * The detail takes no query params — the empty strict schema makes that a
 * contract (C-3): any param is a 400, never silently ignored.
 */
const detailQuerySchema = z.strictObject({});

export class GetSessionDetailController implements Controller {
  private readonly getSessionDetail: GetSessionDetailUseCase;

  constructor(args: { getSessionDetail: GetSessionDetailUseCase }) {
    this.getSessionDetail = args.getSessionDetail;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const sessionId = (httpRequest.params as { id?: string } | undefined)?.id;

    if (!sessionId) {
      return buildBadRequest(new InvalidParamError('id'));
    }

    const parsedQuery = parseQuery(detailQuerySchema, httpRequest.query);

    if (!parsedQuery.ok) return parsedQuery.response;

    const detail = await this.getSessionDetail.get(sessionId);

    if (!detail) {
      return buildNotFound(new NotFoundError(`session ${sessionId}`));
    }

    return buildSuccess(toSessionDetail(detail, new Date()));
  }
}
