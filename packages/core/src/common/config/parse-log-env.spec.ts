import { z } from 'zod';
import {
  bootstrapLoggerOptions,
  logEnvSchemaShape,
  toLoggingEnvironment,
} from './parse-log-env.js';

/**
 * Same contract as the Mongo reader (audit C-6): core owns the knob's
 * meaning, both images spread this one parser.
 */
describe('shared logging env parser', () => {
  const schema = z.object(logEnvSchemaShape);

  it('MUST accept every valid level and both formats', () => {
    for (const level of [
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'silent',
    ]) {
      expect(schema.safeParse({ LOG_LEVEL: level }).success).toBe(true);
    }
    expect(schema.safeParse({ LOG_FORMAT: 'json' }).success).toBe(true);
    expect(schema.safeParse({ LOG_FORMAT: 'pretty' }).success).toBe(true);
  });

  it('MUST treat empty string as unset (compose forwards `${VAR:-}`)', () => {
    const parsed = schema.parse({ LOG_LEVEL: '', LOG_FORMAT: '' });

    expect(parsed.LOG_LEVEL).toBeUndefined();
    expect(parsed.LOG_FORMAT).toBeUndefined();
  });

  it("MUST refuse garbage — a typo'd knob crashes the boot, not the level (audit F-4)", () => {
    expect(schema.safeParse({ LOG_LEVEL: 'verbose' }).success).toBe(false);
    expect(schema.safeParse({ LOG_FORMAT: 'text' }).success).toBe(false);
  });

  it('MUST default to info/json in production, pretty in development, SILENT in test', () => {
    const production = { isDevelopment: false, isTest: false };
    const development = { isDevelopment: true, isTest: false };
    const test = { isDevelopment: false, isTest: true };

    expect(toLoggingEnvironment({}, production)).toEqual({
      logLevel: 'info',
      logFormat: 'json',
    });
    expect(toLoggingEnvironment({}, development)).toEqual({
      logLevel: 'info',
      logFormat: 'pretty',
    });
    // Suites own their output — an info default would bypass jest's console
    // capture (the logger writes to process.stdout directly).
    expect(toLoggingEnvironment({}, test).logLevel).toBe('silent');
    expect(
      toLoggingEnvironment(
        { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' },
        development,
      ),
    ).toEqual({ logLevel: 'debug', logFormat: 'json' });
    // Explicit LOG_LEVEL beats the test silence — that is the opt-in.
    expect(toLoggingEnvironment({ LOG_LEVEL: 'warn' }, test).logLevel).toBe(
      'warn',
    );
  });

  describe('bootstrapLoggerOptions (the boot logger exists BEFORE strict parsing)', () => {
    it('MUST read valid knobs and fall back on invalid ones instead of throwing', () => {
      expect(
        bootstrapLoggerOptions(
          { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' },
          { isDevelopment: true, isTest: false },
        ),
      ).toEqual({ logLevel: 'debug', logFormat: 'json' });

      expect(
        bootstrapLoggerOptions(
          { LOG_LEVEL: 'verbose', LOG_FORMAT: 'text' },
          { isDevelopment: false, isTest: false },
        ),
      ).toEqual({ logLevel: 'info', logFormat: 'json' });
    });
  });
});
