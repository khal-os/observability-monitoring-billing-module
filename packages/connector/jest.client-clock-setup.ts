/** Decision 130 — see core's twin file for the rationale. */
import { initializeClientClock } from '@observability/core/common/helpers/clock/client-clock.js';

initializeClientClock(process.env['CLIENT_TIMEZONE'] || 'America/Sao_Paulo');
