/**
 * THE logging port. Every layer that needs to log depends on this interface
 * only — the writing side (format, destination, level filtering) is chosen
 * once, at each composition root, and injected down. `common` owns it for
 * the same reason it owns the clock and the money helpers: it is a
 * cross-cutting concern every layer may use and no layer may configure.
 *
 * Levels follow the market-standard severity ladder (pino/syslog order).
 * `fatal` is reserved for "the process is about to exit because of this".
 */
export const LOG_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** `silent` is a configuration value only — nothing is ever logged AT silent. */
export type LogLevelSetting = LogLevel | 'silent';

export const LOG_LEVEL_SETTINGS = [...LOG_LEVELS, 'silent'] as const;

/**
 * Structured context attached to a line. Values are serialized by the
 * implementation (errors expanded to name/message/stack, cycles cut) — call
 * sites pass plain data and never pre-format.
 */
export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;

  /**
   * A logger that stamps `bindings` onto every line it writes — the way a
   * job, request or use case gets its identity into the log without every
   * call site repeating it.
   */
  child(bindings: LogFields): Logger;

  /** True when a line at `level` would actually be written. */
  isLevelEnabled(level: LogLevel): boolean;
}

const LEVEL_WEIGHT: Record<LogLevelSetting, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Infinity,
};

export const isLevelEnabled = (
  configured: LogLevelSetting,
  level: LogLevel,
): boolean => LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configured];

export const isLogLevelSetting = (value: string): value is LogLevelSetting =>
  (LOG_LEVEL_SETTINGS as readonly string[]).includes(value);
