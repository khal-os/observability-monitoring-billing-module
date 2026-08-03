import { ApiError } from './api-error.js';

export class MethodNotAllowedError extends ApiError {
  constructor(description: string) {
    super('MethodNotAllowedError', `Method not allowed: ${description}`);
  }
}
