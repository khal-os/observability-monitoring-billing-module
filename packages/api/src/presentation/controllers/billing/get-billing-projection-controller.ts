import {
  Controller,
  GetBillingProjectionUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { toBillingProjectionView } from './billing-view-model.js';

/**
 * US12: always the CURRENT month — a projection of a past month is a
 * contradiction, so the endpoint takes no month parameter at all.
 */
export class GetBillingProjectionController implements Controller {
  private readonly getBillingProjection: GetBillingProjectionUseCase;

  constructor(args: { getBillingProjection: GetBillingProjectionUseCase }) {
    this.getBillingProjection = args.getBillingProjection;
  }

  async handle(_httpRequest: HttpRequest): Promise<HttpResponse> {
    const projection = await this.getBillingProjection.get();

    return buildSuccess(toBillingProjectionView(projection));
  }
}
