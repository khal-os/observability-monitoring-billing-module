import { beatProcessHeartbeat } from '@observability/core/common/helpers/heartbeat/process-heartbeat.js';
import { Logger } from '@observability/core/common/logging/logger.js';
import { nullLogger } from '@observability/core/common/logging/null-logger.js';

/**
 * Liveness that means PROGRESS, not process existence (audit G-1). The old
 * healthcheck was `pgrep node`, which reads "healthy" for every failure
 * shape that leaves the process alive — a hung ClickHouse socket, a
 * promise that never settles, a cursor spinning on the same batch — while
 * the source's ~49-day retention burns behind the stall (invariant 6,
 * the silent kind).
 *
 * The worker touches this file after every successfully completed batch;
 * error paths deliberately do NOT beat. The compose healthcheck asserts
 * freshness against 2×interval+120s — see the trace-ingestion-worker
 * service in compose.connector.yml, which must point at THIS path.
 * (The write itself is core's beatProcessHeartbeat — one helper for every
 * loop; the billing-close scheduler beats its own file the same way.)
 */
export const WORKER_HEARTBEAT_PATH = '/tmp/trace-ingestion-heartbeat';

export const beatWorkerHeartbeat = (
  path: string = WORKER_HEARTBEAT_PATH,
  logger: Logger = nullLogger,
): void => {
  beatProcessHeartbeat(path, 'Trace ingestion worker', logger);
};
