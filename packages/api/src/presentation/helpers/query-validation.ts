import { z } from 'zod';
import { HttpResponse } from '../interfaces/index.js';
import { InvalidParamError } from '../errors/index.js';
import { buildBadRequest } from './http-helper.js';

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};

/**
 * Express delivers query params as strings — schemas must coerce. On
 * failure the controller answers 400 with the offending param name
 * (NOT the throwing safeParse helper: request validation is a client
 * error, never a 500).
 */
export const parseQuery = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  query: unknown,
):
  | { ok: true; value: z.infer<Schema> }
  | { ok: false; response: HttpResponse } => {
  const parsed = schema.safeParse(query ?? {});

  if (!parsed.success) {
    const paramName = parsed.error.issues[0]?.path.join('.') || 'query';

    return {
      ok: false,
      response: buildBadRequest(new InvalidParamError(paramName)),
    };
  }

  return { ok: true, value: parsed.data };
};
