import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER_HEARTBEAT_PATH, beatWorkerHeartbeat } from './worker-heartbeat.js';

describe('worker heartbeat (audit G-1 — progress, not process existence)', () => {
  const path = join(tmpdir(), `heartbeat-spec-${process.pid}`);

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('MUST write a fresh timestamp the healthcheck can age-test', () => {
    const before = Date.now();

    beatWorkerHeartbeat(path);

    const written = new Date(readFileSync(path, 'utf-8')).getTime();

    expect(written).toBeGreaterThanOrEqual(before - 1000);
    expect(written).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('MUST swallow a write failure — a dead beat is the signal, never a crash', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() =>
      beatWorkerHeartbeat('/nonexistent-dir/heartbeat'),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat write failed'),
    );

    warn.mockRestore();
  });

  it('pins the default path the compose healthcheck greps for', () => {
    // compose.connector.yml's freshness test names this path literally —
    // moving it without moving the healthcheck turns the check into a
    // permanent "unhealthy" (fail-closed, but loud in the wrong place).
    expect(WORKER_HEARTBEAT_PATH).toBe('/tmp/trace-ingestion-heartbeat');
  });
});
