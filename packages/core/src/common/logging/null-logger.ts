import { Logger } from './logger.js';

/**
 * The do-nothing Logger — the DEFAULT for injectable constructors so unit
 * tests stay quiet without ceremony. Production factories always pass a
 * real logger; a composition root that forgets loses log lines, not
 * behavior, and the root loggers are created in exactly one place per
 * process (main/), so the omission is visible in review.
 */
const noop = (): void => undefined;

export const nullLogger: Logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: (): Logger => nullLogger,
  isLevelEnabled: (): boolean => false,
};
