import { beatProcessHeartbeat } from '@observability/core/common/helpers/heartbeat/process-heartbeat.js';

/**
 * The billing-close scheduler's progress beat (audit G-1 semantics, same
 * as the trace-ingestion worker's): touched after every COMPLETED
 * evaluation cycle — a blocked close is a completed decision and beats;
 * error paths do NOT, so a hung Mongo socket ages the file and the compose
 * healthcheck flips. The billing-close-scheduler service in
 * compose.module.yml names this path literally.
 */
export const BILLING_CLOSE_HEARTBEAT_PATH = '/tmp/billing-close-heartbeat';

export const beatSchedulerHeartbeat = (
  path: string = BILLING_CLOSE_HEARTBEAT_PATH,
): void => {
  beatProcessHeartbeat(path, 'Billing close scheduler');
};
