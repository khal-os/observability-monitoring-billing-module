/**
 * Mongo server error 11000: a unique-index violation. THE house predicate —
 * every adapter that turns E11000 into domain meaning (idempotent skip,
 * duplicate price version, lost close race, $merge first-touch retry)
 * shares this single check instead of a hand-rolled copy per repository.
 */
export const isDuplicateKeyError = (error: unknown): boolean =>
  (error as { code?: number } | null)?.code === 11000;
