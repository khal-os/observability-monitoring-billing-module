import { ApiError } from './api-error.js';

export class ServerError extends ApiError {
  constructor() {
    super('ServerError', 'Internal server error');
  }
}
