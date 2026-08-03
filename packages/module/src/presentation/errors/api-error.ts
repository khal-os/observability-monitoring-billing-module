/**
 * Base of every presentation-layer error. The API's error wire shape is
 * `{name, msg}` — `res.json(error)` serializes own-enumerable properties
 * only, so the base makes the contract structural: `name` and `msg` are
 * own-enumerable by construction (message/stack stay non-enumerable and
 * never leak), instead of seven hand-maintained conventions.
 */
export class ApiError extends Error {
  msg: string;

  constructor(name: string, message: string) {
    super(message);

    this.name = name;
    this.msg = message;
  }
}
