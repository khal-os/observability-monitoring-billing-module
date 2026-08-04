import { ApiError } from './api-error.js';

export class UnsupportedMediaTypeError extends ApiError {
  constructor(received: string) {
    super(
      'UnsupportedMediaTypeError',
      `Unsupported media type: ${received} — this API accepts application/json only`,
    );
  }
}
