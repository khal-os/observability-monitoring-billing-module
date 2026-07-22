import {
  Controller,
  HttpRequest,
  HttpResponse,
  ListBillsUseCase,
} from './billing-protocols.js';
import { buildSuccess } from '../../helpers/http-helper.js';
import { toBillListView } from './billing-view-model.js';

export class ListBillsController implements Controller {
  private readonly listBills: ListBillsUseCase;

  constructor(args: { listBills: ListBillsUseCase }) {
    this.listBills = args.listBills;
  }

  async handle(_httpRequest: HttpRequest): Promise<HttpResponse> {
    const bills = await this.listBills.list();

    return buildSuccess(toBillListView(bills));
  }
}
