import { ApiError } from './api-error.js';

/**
 * The house 400. `paramName` always names the offending parameter; the
 * optional `explanation` replaces the generic message when the caller
 * already has a better one to give — today, a domain rejection whose own
 * text explains WHY the parameter is invalid (a future billing month).
 * Wrapping such a rejection keeps its explanation while putting the
 * structural {name, msg} contract (and an internal class name off the
 * wire) back in the presentation layer, where it belongs.
 */
export class InvalidParamError extends ApiError {
  constructor(paramName: string, explanation?: string) {
    super('InvalidParamError', explanation ?? `Invalid parameter: ${paramName}`);
  }
}
