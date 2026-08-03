import { z } from 'zod';
import { HttpResponse } from '../interfaces/index.js';
import { InvalidParamError, MissingParamError } from '../errors/index.js';
import { buildBadRequest } from './http-helper.js';
import { MAX_PAGINATION_SKIP } from '@khal/core/domain/models/pagination.js';

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

/**
 * Date query params accept ONLY ISO shapes — 'YYYY-MM-DD' or an ISO
 * datetime CARRYING ITS OFFSET (Z or ±hh:mm). Timezone-less local
 * datetimes are rejected (B-8): new Date() would read them in the
 * SERVER's timezone, so "2026-06-01T00:00:00" filters by a different
 * instant per host. z.coerce.date() takes anything new Date() takes
 * ("5" → 2001-05-01) and would silently filter by a bogus instant. The
 * NaN refine catches ISO-shaped impossible dates (e.g. 2026-02-30) that
 * survive the format check.
 */
export const isoDateParam = z
  .union([z.iso.date(), z.iso.datetime({ offset: true })])
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()));

/**
 * Calendar-month address shared by the billing endpoints (C-3): both
 * required, coerced from the query strings, bounded like the OpenAPI doc
 * says. Spread into a z.strictObject so an unknown param is a 400, never
 * silently ignored — the same policy the traces/sessions layer states.
 */
export const yearMonthQueryShape = {
  year: z.coerce.number().int().min(1970).max(9999),
  month: z.coerce.number().int().min(1).max(12),
};

/**
 * Cross-field rule (checked after parse, like the pagination depth): an
 * inverted period can never match anything — answered as a plain 400
 * on `from`.
 */
export const invalidPeriod = (value: { from?: Date; to?: Date }): boolean =>
  value.from !== undefined && value.to !== undefined && value.from > value.to;

export const invalidPeriodResponse = (): HttpResponse =>
  buildBadRequest(new InvalidParamError('from'));

/**
 * Depth guard for list endpoints: the skip a page implies must stay
 * within the same 10.000-document horizon that caps the totals
 * (decision 79) — beyond it every request is an O(skip) index walk.
 * Checked after parse (it spans two fields), answered as a plain 400
 * on `page` like any other invalid param.
 */
export const exceedsPaginationDepth = (value: {
  page: number;
  page_size: number;
}): boolean => (value.page - 1) * value.page_size >= MAX_PAGINATION_SKIP;

export const paginationDepthExceededResponse = (): HttpResponse =>
  buildBadRequest(new InvalidParamError('page'));

/**
 * Express delivers query params as strings — schemas must coerce. On
 * failure the controller answers 400 with the offending param name
 * (NOT the throwing safeParse helper: request validation is a client
 * error, never a 500). House rule (same as the POST /prices body):
 * absent required param → MissingParamError; wrong shape →
 * InvalidParamError on that param.
 */
export const parseQuery = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  query: unknown,
):
  | { ok: true; value: z.infer<Schema> }
  | { ok: false; response: HttpResponse } => {
  const parsed = schema.safeParse(query ?? {});

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Strict objects report unknown params as one unrecognized_keys issue
    // with an empty path — the offending name lives in `keys`. Otherwise,
    // first path segment only: query params are flat — an issue inside a
    // repeated param (path ['agent', 1]) is still the param `agent`.
    const paramName =
      issue?.code === 'unrecognized_keys'
        ? (issue.keys[0] ?? 'query')
        : String(issue?.path[0] ?? '') || 'query';

    const missing =
      issue?.code !== 'unrecognized_keys' &&
      (query as Record<string, unknown> | null | undefined)?.[paramName] ===
        undefined;

    return {
      ok: false,
      response: buildBadRequest(
        missing
          ? new MissingParamError(paramName)
          : new InvalidParamError(paramName),
      ),
    };
  }

  return { ok: true, value: parsed.data };
};
