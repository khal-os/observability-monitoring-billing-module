import { ApiError } from './api-error.js';

export class InvalidParamError extends ApiError {
  constructor(paramName: string) {
    super('InvalidParamError', `Invalid parameter: ${paramName}`);
  }
}
