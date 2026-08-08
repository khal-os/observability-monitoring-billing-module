import {
  LogFields,
  LogLevel,
  LogLevelSetting,
  LOG_LEVELS,
  Logger,
  isLevelEnabled,
} from './logger.js';

/**
 * The ONE Logger implementation: structured lines on stdout, level-filtered.
 *
 * `json` (the default) emits one JSON object per line — the shape log
 * shippers and `docker logs | jq` expect: {time, level, msg, ...bindings,
 * ...fields}. `pretty` is the dev-loop format (tsx watch): aligned level,
 * message, then `key=value` context.
 *
 * Deliberately dependency-free (no pino/winston): core is the bottom of the
 * workspace graph and every runtime image inherits its dependency set; the
 * whole feature set we need — levels, children, error serialization — fits
 * in a page, and the PORT (logger.ts) is what call sites see, so swapping
 * a heavier backend later is a composition-root-only change.
 */
export type LogFormat = 'json' | 'pretty';

export const LOG_FORMATS = ['json', 'pretty'] as const;

export const isLogFormat = (value: string): value is LogFormat =>
  (LOG_FORMATS as readonly string[]).includes(value);

export interface StructuredLoggerOptions {
  /** Minimum level actually written. Default: 'info'. */
  level?: LogLevelSetting;
  /** Line shape. Default: 'json'. */
  format?: LogFormat;
  /** Stamped onto every line — e.g. { service: 'module' }. */
  bindings?: LogFields;
  /** Line sink, '\n' included by the logger. Default: process.stdout. */
  write?: (line: string) => void;
  /** Clock, injectable for tests. Default: () => new Date(). */
  now?: () => Date;
}

/**
 * Errors logged as fields must keep their stack — JSON.stringify(new
 * Error(...)) yields '{}'. Applied recursively one level deep via the
 * stringify replacer below.
 */
const serializeError = (error: Error): LogFields => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  ...(error.cause !== undefined ? { cause: safeSerialize(error.cause) } : {}),
});

const safeSerialize = (value: unknown): unknown =>
  value instanceof Error ? serializeError(value) : value;

/** JSON.stringify that survives cycles and Errors — a log call must never throw. */
const safeStringify = (value: Record<string, unknown>): string => {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Error) return serializeError(entry);

    if (typeof entry === 'bigint') return entry.toString();

    if (typeof entry === 'object' && entry !== null) {
      if (seen.has(entry)) return '[circular]';
      seen.add(entry);
    }

    return entry;
  });
};

const PRETTY_LEVEL: Record<LogLevel, string> = {
  trace: 'TRACE',
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
  fatal: 'FATAL',
};

const prettyFields = (fields: LogFields): string =>
  Object.entries(fields)
    .map(([key, value]) => {
      const serialized = safeSerialize(value);

      return `${key}=${
        typeof serialized === 'string'
          ? serialized
          : safeStringify({ v: serialized }).slice(5, -1)
      }`;
    })
    .join(' ');

export const createLogger = (options: StructuredLoggerOptions = {}): Logger => {
  const level = options.level ?? 'info';
  const format = options.format ?? 'json';
  const bindings = options.bindings ?? {};
  const write =
    options.write ?? ((line: string): void => void process.stdout.write(line));
  const now = options.now ?? ((): Date => new Date());

  const emit = (lineLevel: LogLevel, message: string, fields?: LogFields) => {
    if (!isLevelEnabled(level, lineLevel)) return;

    const context = { ...bindings, ...fields };

    if (format === 'json') {
      write(
        `${safeStringify({
          time: now().toISOString(),
          level: lineLevel,
          msg: message,
          ...context,
        })}\n`,
      );

      return;
    }

    const rendered = prettyFields(context);

    write(
      `${now().toISOString()} ${PRETTY_LEVEL[lineLevel]} ${message}${
        rendered ? ` · ${rendered}` : ''
      }\n`,
    );
  };

  const methods = Object.fromEntries(
    LOG_LEVELS.map((lineLevel) => [
      lineLevel,
      (message: string, fields?: LogFields) => emit(lineLevel, message, fields),
    ]),
  ) as Pick<Logger, LogLevel>;

  return {
    ...methods,
    child: (childBindings: LogFields): Logger =>
      createLogger({
        ...options,
        bindings: { ...bindings, ...childBindings },
      }),
    isLevelEnabled: (lineLevel: LogLevel): boolean =>
      isLevelEnabled(level, lineLevel),
  };
};
