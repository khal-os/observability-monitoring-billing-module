export class MissingParamError extends Error {
  msg: string;

  constructor(paramName: string) {
    super(`Missing parameter: ${paramName}`);

    this.name = 'MissingParamError';
    this.msg = `Missing parameter: ${paramName}`;
  }
}
