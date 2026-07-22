export class InvalidParamError extends Error {
  msg: string;

  constructor(paramName: string) {
    super(`Invalid parameter: ${paramName}`);

    this.name = 'InvalidParamError';
    this.msg = `Invalid parameter: ${paramName}`;
  }
}
