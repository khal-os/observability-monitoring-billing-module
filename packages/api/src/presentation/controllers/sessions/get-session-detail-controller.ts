import {
  Controller,
  GetSessionDetailUseCase,
  HttpRequest,
  HttpResponse,
} from './sessions-protocols.js';
import { buildBadRequest, buildNotFound, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';
import { toSessionDetail } from './session-view-model.js';

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

    const detail = await this.getSessionDetail.get(sessionId);

    if (!detail) {
      return buildNotFound(new NotFoundError(`session ${sessionId}`));
    }

    return buildSuccess(toSessionDetail(detail, new Date()));
  }
}
