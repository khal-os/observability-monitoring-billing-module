import { HttpRequest, HttpResponse } from './http.js';

export interface Controller {
  handle(httpRequest: HttpRequest): Promise<HttpResponse>;
}
