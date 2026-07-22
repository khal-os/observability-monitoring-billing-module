import { HttpResponse } from '../interfaces/index.js';

export const buildBadRequest = (error: Error): HttpResponse => ({
  statusCode: 400,
  body: error,
});

export const buildSuccess = (data: unknown): HttpResponse => ({
  statusCode: 200,
  body: data,
});

export const buildNotFound = (error: Error): HttpResponse => ({
  statusCode: 404,
  body: error,
});

export const buildServerError = (error: Error): HttpResponse => ({
  statusCode: 500,
  body: error,
});

/**
 * Pagination display rule (decision 51): the page count is API-computed —
 * the front never derives it. An empty result still has 1 page.
 */
export const totalPages = (total: number, pageSize: number): number =>
  Math.max(1, Math.ceil(total / pageSize));
