export class PayloadTooLargeError extends Error {
  msg: string;

  constructor() {
    super('Payload too large');

    this.name = 'PayloadTooLargeError';
    this.msg = 'Payload too large';
  }
}
