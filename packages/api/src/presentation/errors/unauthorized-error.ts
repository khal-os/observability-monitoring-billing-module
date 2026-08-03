import { ApiError } from './api-error.js';

export class UnauthorizedError extends ApiError {
  constructor() {
    super('UnauthorizedError', 'Unauthorized');
  }
}
