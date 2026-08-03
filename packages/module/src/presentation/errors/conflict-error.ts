import { ApiError } from './api-error.js';

/**
 * 409 body for writes that collide with an immutable record — today, a
 * duplicate (model, tokenType, effectiveFrom) price version (invariant 9:
 * versions are immutable; a change is a NEW effective-from).
 */
export class ConflictError extends ApiError {
  constructor(message: string) {
    super('ConflictError', message);
  }
}
