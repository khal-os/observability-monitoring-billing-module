export class NotFoundError extends Error {
  msg: string;

  constructor(resource: string) {
    super(`Not found: ${resource}`);

    this.name = 'NotFoundError';
    this.msg = `Not found: ${resource}`;
  }
}
