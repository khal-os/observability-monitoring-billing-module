import { LogFields, LogLevel, LOG_LEVELS, Logger } from './logger.js';

/**
 * Recording Logger for unit suites — the replacement for spying on
 * console.*: inject it through the same seam production uses and assert on
 * what was logged, not on how the sink renders it.
 */
export interface RecordedLine {
  level: LogLevel;
  message: string;
  fields: LogFields;
}

export class RecordingLogger implements Logger {
  readonly lines: RecordedLine[] = [];

  private readonly bindings: LogFields;

  constructor(bindings: LogFields = {}, lines?: RecordedLine[]) {
    this.bindings = bindings;

    if (lines) this.lines = lines;
  }

  private record(level: LogLevel, message: string, fields?: LogFields): void {
    this.lines.push({
      level,
      message,
      fields: { ...this.bindings, ...fields },
    });
  }

  trace(message: string, fields?: LogFields): void {
    this.record('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.record('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.record('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.record('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.record('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.record('fatal', message, fields);
  }

  /** Children share the parent's `lines` array — the suite asserts in one place. */
  child(bindings: LogFields): Logger {
    return new RecordingLogger({ ...this.bindings, ...bindings }, this.lines);
  }

  isLevelEnabled(): boolean {
    return true;
  }

  /** The recorded lines at `level` — the usual assertion surface. */
  at(level: LogLevel): RecordedLine[] {
    return this.lines.filter((line) => line.level === level);
  }

  /** All recorded messages, cheapest way to assert "nothing was logged". */
  messages(level?: LogLevel): string[] {
    return (level ? this.at(level) : this.lines).map((line) => line.message);
  }
}

/** Type guard so tests can exhaustively cover levels without retyping the list. */
export const isRecordableLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);
