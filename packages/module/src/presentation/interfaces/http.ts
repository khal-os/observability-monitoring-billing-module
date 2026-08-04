type StatusCode = number
type Body = unknown
type Query = unknown
type Params = unknown
type Headers = unknown

export interface HttpResponse {
  statusCode: StatusCode;
  body: Body;
  /**
   * Extra response headers, applied whenever present (audit D-7: cache
   * directives ride JSON responses too — a CLOSED month is immutable and
   * may say so). Middleware defaults (no-store) are overridden here.
   */
  headers?: Record<string, string>;
  /**
   * True → the adapter sends the body RAW (res.send) — file downloads and
   * print views (US17). Default: JSON.
   */
  raw?: boolean;
}

export interface HttpRequest {
  body?: Body;
  query?: Query;
  params?: Params;
  headers?: Headers;
}