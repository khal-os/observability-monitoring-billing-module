import { writeFileSync } from 'node:fs';
import { Logger } from '../../logging/logger.js';
import { nullLogger } from '../../logging/null-logger.js';

/**
 * Liveness that means PROGRESS, not process existence (audit G-1). A
 * long-lived loop touches its heartbeat file after every successfully
 * completed cycle; error paths deliberately do NOT beat, so a hung socket
 * or a wedged promise turns the container unhealthy instead of
 * green-while-dead. The compose healthcheck asserts the file's freshness
 * against 2×interval+120s.
 *
 * One helper for every loop (trace-ingestion worker, billing-close
 * scheduler): the path and the log label are the caller's — each service's
 * compose healthcheck names ITS path literally.
 */
export const beatProcessHeartbeat = (
  path: string,
  label: string,
  logger: Logger = nullLogger,
): void => {
  try {
    writeFileSync(path, new Date().toISOString());
  } catch (error) {
    // A failing beat must never take down the loop — the healthcheck
    // going stale IS the signal, and the cause will be in this log line.
    logger.warn(`${label}: heartbeat write failed`, { path, err: error });
  }
};
