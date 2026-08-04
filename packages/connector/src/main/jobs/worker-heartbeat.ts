import { writeFileSync } from 'node:fs';

/**
 * Liveness that means PROGRESS, not process existence (audit G-1). The old
 * healthcheck was `pgrep node`, which reads "healthy" for every failure
 * shape that leaves the process alive — a hung ClickHouse socket, a
 * promise that never settles, a cursor spinning on the same batch — while
 * the source's ~49-day retention burns behind the stall (invariant 6,
 * the silent kind).
 *
 * The worker touches this file after every successfully completed batch;
 * error paths deliberately do NOT beat, so a source outage or a wedge
 * turns the container unhealthy instead of green-while-dead. The compose
 * healthcheck asserts freshness against 2×interval+120s — see the
 * trace-ingestion-worker service in compose.connector.yml, which must
 * point at THIS path.
 */
export const WORKER_HEARTBEAT_PATH = '/tmp/trace-ingestion-heartbeat';

export const beatWorkerHeartbeat = (
  path: string = WORKER_HEARTBEAT_PATH,
): void => {
  try {
    writeFileSync(path, new Date().toISOString());
  } catch (error) {
    // A failing beat must never take down ingestion — the healthcheck
    // going stale IS the signal, and the cause will be in this log line.
    console.warn(`Trace ingestion worker: heartbeat write failed: ${String(error)}`);
  }
};
