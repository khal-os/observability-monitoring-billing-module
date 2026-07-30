export class UnauthorizedError extends Error {
  msg: string;

  constructor() {
    super('Unauthorized');

    this.name = 'UnauthorizedError';
    this.msg = 'Unauthorized';
  }
}
