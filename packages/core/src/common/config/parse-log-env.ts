import { z } from 'zod';
import {
  LOG_LEVEL_SETTINGS,
  LogLevelSetting,
  isLogLevelSetting,
} from '../logging/logger.js';
import {
  LOG_FORMATS,
  LogFormat,
  isLogFormat,
} from '../logging/structured-logger.js';

/**
 * THE shared logging env reader — same rationale as parse-mongo-env (audit
 * C-6): core owns the knob's meaning, so both images read it identically.
 *
 * Knobs:
 * - LOG_LEVEL: trace|debug|info|warn|error|fatal|silent (default: info)
 * - LOG_FORMAT: json|pretty (default: json in production/test, pretty in
 *   development — the dev loop is read by a human, everything else by a
 *   shipper)
 *
 * Empty string means UNSET (compose forwards `${LOG_LEVEL:-}`), same rule
 * as every optional knob. A NON-empty garbage value fails the strict parse
 * and the boot (audit F-4: a typo'd knob must crash loudly, not silently
 * log at the wrong level) — but see bootstrapLoggerOptions below for how
 * that failure itself gets logged.
 */
export const logEnvSchemaShape = {
  LOG_LEVEL: z.preprocess(
    (value) => value || undefined,
    z.enum(LOG_LEVEL_SETTINGS).optional(),
  ),
  LOG_FORMAT: z.preprocess(
    (value) => value || undefined,
    z.enum(LOG_FORMATS).optional(),
  ),
} as const;

export interface LoggingEnvironmentVariables {
  logLevel: LogLevelSetting;
  logFormat: LogFormat;
}

export interface LoggingEnvironmentContext {
  /** development → pretty format fallback (the dev loop is read by a human). */
  isDevelopment: boolean;
  /**
   * test → SILENT fallback: suites own their output, and the logger writes
   * to process.stdout directly, which bypasses jest's console capture — an
   * info default would spray lines through every integration suite. A suite
   * that wants log output sets LOG_LEVEL explicitly.
   */
  isTest: boolean;
}

/** Applies the defaults; the environment kind decides the fallbacks. */
export const toLoggingEnvironment = (
  env: { LOG_LEVEL?: LogLevelSetting; LOG_FORMAT?: LogFormat },
  { isDevelopment, isTest }: LoggingEnvironmentContext,
): LoggingEnvironmentVariables => ({
  logLevel: env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  logFormat: env.LOG_FORMAT ?? (isDevelopment ? 'pretty' : 'json'),
});

/**
 * Tolerant reader for the boot sequence: the root logger must exist BEFORE
 * the strict env parse so a validation failure lands in a real, structured
 * log line. Invalid values fall back to the defaults here — the strict
 * schema above still rejects them a moment later, so tolerance never
 * outlives the boot.
 */
export const bootstrapLoggerOptions = (
  env: Record<string, string | undefined>,
  context: LoggingEnvironmentContext,
): LoggingEnvironmentVariables => {
  const level = env['LOG_LEVEL'];
  const format = env['LOG_FORMAT'];

  return toLoggingEnvironment(
    {
      LOG_LEVEL: level && isLogLevelSetting(level) ? level : undefined,
      LOG_FORMAT: format && isLogFormat(format) ? format : undefined,
    },
    context,
  );
};
