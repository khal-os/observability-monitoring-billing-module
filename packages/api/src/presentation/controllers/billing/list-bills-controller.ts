import { z } from 'zod';
import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListBillsUseCase,
} from './billing-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { parseQuery } from '../../helpers/query-validation.js';
import { toBillListView } from './billing-view-model.js';

/**
 * The bill list takes no parameters — the empty strict schema makes that
 * a contract (C-3): any param is a 400, never silently ignored.
 */
const billsQuerySchema = z.strictObject({});

export class ListBillsController implements Controller {
  private readonly listBills: ListBillsUseCase;

  constructor(args: { listBills: ListBillsUseCase }) {
    this.listBills = args.listBills;
  }

  async handle(httpRequest: HttpRequest): Promise<HttpResponse> {
    const parsed = parseQuery(billsQuerySchema, httpRequest.query);

    if (!parsed.ok) return parsed.response;

    const bills = await this.listBills.list();

    return buildSuccess(toBillListView(bills));
  }
}
