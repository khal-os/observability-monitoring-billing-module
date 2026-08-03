export class MethodNotAllowedError extends Error {
  msg: string;

  constructor(description: string) {
    super(`Method not allowed: ${description}`);

    this.name = 'MethodNotAllowedError';
    this.msg = `Method not allowed: ${description}`;
  }
}
