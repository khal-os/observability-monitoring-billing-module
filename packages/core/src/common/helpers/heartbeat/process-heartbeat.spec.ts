import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beatProcessHeartbeat } from './process-heartbeat.js';
import { RecordingLogger } from '../../logging/logging-test-fakes.js';

describe('process heartbeat (audit G-1 — progress, not process existence)', () => {
  const path = join(tmpdir(), `process-heartbeat-spec-${process.pid}`);

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('MUST write a fresh timestamp the healthcheck can age-test', () => {
    const before = Date.now();

    beatProcessHeartbeat(path, 'Spec loop');

    const written = new Date(readFileSync(path, 'utf-8')).getTime();

    expect(written).toBeGreaterThanOrEqual(before - 1000);
    expect(written).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('MUST swallow a write failure — a dead beat is the signal, never a crash', () => {
    const logger = new RecordingLogger();

    expect(() =>
      beatProcessHeartbeat('/nonexistent-dir/heartbeat', 'Spec loop', logger),
    ).not.toThrow();
    expect(logger.messages('warn')).toEqual([
      'Spec loop: heartbeat write failed',
    ]);
  });
});
