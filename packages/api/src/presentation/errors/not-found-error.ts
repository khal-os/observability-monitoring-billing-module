import { ApiError } from './api-error.js';

export class NotFoundError extends ApiError {
  constructor(resource: string) {
    super('NotFoundError', `Not found: ${resource}`);
  }
}
