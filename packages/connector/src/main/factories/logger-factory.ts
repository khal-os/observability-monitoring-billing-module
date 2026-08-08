import {
  LogFields,
  Logger,
} from '@observability/core/common/logging/logger.js';
import { createLogger } from '@observability/core/common/logging/structured-logger.js';
import { config } from '../../infrastructure/configuration/config.js';

/**
 * THE root logger of the connector image — the worker loop and the run-sync
 * job create their loggers here so LOG_LEVEL/LOG_FORMAT are read in exactly
 * one place and every line carries `service: connector`.
 */
export const makeLogger = (bindings: LogFields = {}): Logger =>
  createLogger({
    level: config.logLevel,
    format: config.logFormat,
    bindings: { service: 'connector', ...bindings },
  });
