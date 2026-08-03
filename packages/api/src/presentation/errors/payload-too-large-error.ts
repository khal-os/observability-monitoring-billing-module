import { ApiError } from './api-error.js';

export class PayloadTooLargeError extends ApiError {
  constructor() {
    super('PayloadTooLargeError', 'Payload too large');
  }
}
