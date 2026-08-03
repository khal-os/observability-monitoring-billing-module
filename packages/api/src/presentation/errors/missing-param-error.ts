import { ApiError } from './api-error.js';

export class MissingParamError extends ApiError {
  constructor(paramName: string) {
    super('MissingParamError', `Missing parameter: ${paramName}`);
  }
}
