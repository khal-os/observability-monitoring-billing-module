type StatusCode = number
type Body = unknown
type Query = unknown
type Params = unknown
type Headers = unknown

export interface HttpResponse {
  statusCode: StatusCode;
  body: Body;
}

export interface HttpRequest {
  body?: Body;
  query?: Query;
  params?: Params;
  headers?: Headers;
}