/**
 * Decision 130: every suite runs under the client clock the deployment
 * would have — production boots initialize it from the REQUIRED
 * CLIENT_TIMEZONE env in environment-setup; tests initialize it here.
 * Specs exercising other zones re-initialize locally (client-clock.spec).
 */
import { initializeClientClock } from './src/common/helpers/clock/client-clock.js';

initializeClientClock(process.env['CLIENT_TIMEZONE'] || 'America/Sao_Paulo');
