/**
 * 409 body for writes that collide with an immutable record — today, a
 * duplicate (model, tokenType, effectiveFrom) price version (invariant 9:
 * versions are immutable; a change is a NEW effective-from).
 */
export class ConflictError extends Error {
  msg: string;

  constructor(message: string) {
    super(message);

    this.name = 'ConflictError';
    this.msg = message;
  }
}
