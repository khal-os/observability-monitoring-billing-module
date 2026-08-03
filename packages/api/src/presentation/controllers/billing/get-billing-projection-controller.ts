import { z } from 'zod';
import {
  Controller,
  GetBillingProjectionUseCase,
  HttpRequest,
  HttpResponse,
} from './billing-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { parseQuery } from '../../helpers/query-validation.js';
import { toBillingProjectionView } from './billing-view-model.js';

/**
 * US12: always the CURRENT month — a projection of a past month is a
 * contradiction, so the endpoint takes no month parameter at all. The
 * empty strict schema makes that a contract (C-3): any param is a 400,
 * never silently ignored.
 */
const projectionQuerySchema = z.strictObject({});

export class GetBillingProjectionController implements Controller {
  private readonly getBillingProjection: GetBillingProjectionUseCase;

  constructor(args: { getBillingProjection: GetBillingProjectionUseCase }) {
    this.getBillingProjection = args.getBillingProjection;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(projectionQuerySchema, httpRequest.query);

    if (!parsed.ok) return parsed.response;

    const projection = await this.getBillingProjection.get();

    return buildSuccess(toBillingProjectionView(projection));
  }
}
