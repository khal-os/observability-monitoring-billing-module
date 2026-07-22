export class ServerError extends Error {
  msg: string;

  constructor() {
    super('Internal server error');

    this.name = 'ServerError';
    this.msg = 'Internal server error';
  }
}
