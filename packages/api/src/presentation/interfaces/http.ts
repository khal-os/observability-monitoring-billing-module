type StatusCode = number
type Body = unknown
type Query = unknown
type Params = unknown
type Headers = unknown

export interface HttpResponse {
  statusCode: StatusCode;
  body: Body;
  /**
   * When set, the adapter sends the body RAW (res.send) with these
   * headers instead of JSON — file downloads and print views (US17).
   */
  headers?: Record<string, string>;
}

export interface HttpRequest {
  body?: Body;
  query?: Query;
  params?: Params;
  headers?: Headers;
}