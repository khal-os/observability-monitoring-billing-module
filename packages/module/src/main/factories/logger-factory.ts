import {
  LogFields,
  Logger,
} from '@observability/core/common/logging/logger.js';
import { createLogger } from '@observability/core/common/logging/structured-logger.js';
import { config } from '../../infrastructure/configuration/config.js';

/**
 * THE root logger of the module image — every entry point (server, runbook
 * jobs, scheduler) creates its logger here so LOG_LEVEL/LOG_FORMAT are read
 * in exactly one place and every line carries `service: module`.
 */
export const makeLogger = (bindings: LogFields = {}): Logger =>
  createLogger({
    level: config.logLevel,
    format: config.logFormat,
    bindings: { service: 'module', ...bindings },
  });
