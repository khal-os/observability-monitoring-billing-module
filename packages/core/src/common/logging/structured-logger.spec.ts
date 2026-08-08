import { createLogger } from './structured-logger.js';
import { nullLogger } from './null-logger.js';
import { LOG_LEVELS, isLevelEnabled } from './logger.js';

const FROZEN_NOW = new Date('2026-08-08T12:00:00.000Z');

const collectingLogger = (
  options: Omit<Parameters<typeof createLogger>[0], 'write' | 'now'> = {},
) => {
  const lines: string[] = [];
  const logger = createLogger({
    ...options,
    write: (line) => lines.push(line),
    now: () => FROZEN_NOW,
  });

  return { logger, lines };
};

describe('structured logger (the ONE Logger implementation)', () => {
  describe('level filtering', () => {
    it('MUST write at and above the configured level and drop below it', () => {
      const { logger, lines } = collectingLogger({ level: 'warn' });

      logger.trace('t');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      logger.fatal('f');

      expect(lines.map((line) => JSON.parse(line).level)).toEqual([
        'warn',
        'error',
        'fatal',
      ]);
    });

    it('MUST default to info', () => {
      const { logger, lines } = collectingLogger();

      logger.debug('dropped');
      logger.info('kept');

      expect(lines).toHaveLength(1);
    });

    it('MUST write nothing at silent', () => {
      const { logger, lines } = collectingLogger({ level: 'silent' });

      LOG_LEVELS.forEach((level) => logger[level]('dropped'));

      expect(lines).toEqual([]);
    });

    it('MUST expose the decision through isLevelEnabled (guards for expensive fields)', () => {
      const { logger } = collectingLogger({ level: 'info' });

      expect(logger.isLevelEnabled('debug')).toBe(false);
      expect(logger.isLevelEnabled('error')).toBe(true);
      expect(isLevelEnabled('silent', 'fatal')).toBe(false);
    });
  });

  describe('json format (the shipper-facing default)', () => {
    it('MUST emit one JSON object per line with time, level, msg and fields', () => {
      const { logger, lines } = collectingLogger();

      logger.info('trace stored', { traceId: 'tr-1', spans: 3 });

      expect(lines).toHaveLength(1);
      expect(lines[0]!.endsWith('\n')).toBe(true);
      expect(JSON.parse(lines[0]!)).toEqual({
        time: '2026-08-08T12:00:00.000Z',
        level: 'info',
        msg: 'trace stored',
        traceId: 'tr-1',
        spans: 3,
      });
    });

    it('MUST serialize Error fields with name, message and stack — never "{}"', () => {
      const { logger, lines } = collectingLogger();

      logger.error('sync failed', { err: new Error('boom') });

      const parsed = JSON.parse(lines[0]!) as {
        err: { name: string; message: string; stack?: string };
      };

      expect(parsed.err.name).toBe('Error');
      expect(parsed.err.message).toBe('boom');
      expect(parsed.err.stack).toContain('boom');
    });

    it('MUST survive circular fields — a log call never throws', () => {
      const { logger, lines } = collectingLogger();
      const cyclic: Record<string, unknown> = {};

      cyclic['self'] = cyclic;

      expect(() => logger.info('cycle', { cyclic })).not.toThrow();
      expect(lines[0]).toContain('[circular]');
    });
  });

  describe('child bindings', () => {
    it('MUST stamp parent AND child bindings onto every line, fields winning last', () => {
      const { logger, lines } = collectingLogger({
        bindings: { service: 'connector' },
      });

      logger.child({ job: 'sync' }).info('window done', { batches: 2 });

      expect(JSON.parse(lines[0]!)).toMatchObject({
        service: 'connector',
        job: 'sync',
        batches: 2,
      });
    });
  });

  describe('pretty format (the dev loop)', () => {
    it('MUST render level, message and key=value context on one line', () => {
      const { logger, lines } = collectingLogger({ format: 'pretty' });

      logger.warn('price missing', { model: 'gpt-5', count: 2 });

      expect(lines[0]).toBe(
        '2026-08-08T12:00:00.000Z WARN  price missing · model=gpt-5 count=2\n',
      );
    });
  });

  describe('null logger', () => {
    it('MUST swallow everything and answer disabled for every level', () => {
      expect(() => nullLogger.child({ a: 1 }).error('dropped')).not.toThrow();
      expect(nullLogger.isLevelEnabled('fatal')).toBe(false);
    });
  });
});
