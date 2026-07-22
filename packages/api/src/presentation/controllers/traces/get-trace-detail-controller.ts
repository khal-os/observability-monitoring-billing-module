import {
  Controller,
  GetTraceDetailUseCase,
  HttpRequest,
  HttpResponse,
} from './traces-protocols.js';
import { buildBadRequest, buildNotFound, buildSuccess } from '../../helpers/http-helper.js';
import { InvalidParamError, NotFoundError } from '../../errors/index.js';
import { toTraceDetail } from './trace-view-model.js';

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

    const detail = await this.getTraceDetail.get(traceId);

    if (!detail) {
      return buildNotFound(new NotFoundError(`trace ${traceId}`));
    }

    return buildSuccess(toTraceDetail(detail, new Date()));
  }
}
