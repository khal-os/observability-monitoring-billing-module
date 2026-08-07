import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import { initializeClientClock } from '@observability/core/common/helpers/clock/client-clock.js';
import {
  mongoEnvSchemaShape,
  toMongoDbEnvironment,
} from '@observability/core/common/config/parse-mongo-env.js';
import {
  BillingSchedulerEnvironmentVariables,
  MongoDbEnvironmentVariables,
  ServerEnvironmentVariables,
} from '../interfaces/index.js';

const environmentEnum = {
  PRODUCTION: 'production',
  TEST: 'test',
  DEVELOPMENT: 'development',
} as const;

type Environment = (typeof environmentEnum)[keyof typeof environmentEnum];

export interface EnvironmentVariables
  extends ServerEnvironmentVariables,
    MongoDbEnvironmentVariables,
    BillingSchedulerEnvironmentVariables {
  Environment: Environment;
}

/**
 * Optional env string where EMPTY means unset. Compose forwards these vars
 * with `${VAR:-}` defaults, so an env file that omits them delivers '' to
 * the container — which must behave exactly like the var not existing
 * (e.g. an empty AUTH_SYSTEM_URL must not half-enable auth).
 */
const optionalNonEmptyString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

/**
 * Bounded numeric knob (the connector's audit F-4 guard, same rationale):
 * a knob typo'd to 0 or garbage must fail the boot loudly, not configure a
 * busy-loop or a midnight-sharp close nobody chose. The resolved values
 * are echoed at scheduler startup so a misconfiguration is in the first
 * lines of the log.
 */
const optionalBoundedIntString = (name: string, max: number) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a decimal integer string`)
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;

      const parsed = Number(value);

      if (parsed < 1 || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `${name} must be between 1 and ${max} (audit F-4)`,
        });
      }
    });

const envSchema = z
  .object({
    ENVIRONMENT: z.enum([
      environmentEnum.PRODUCTION,
      environmentEnum.TEST,
      environmentEnum.DEVELOPMENT,
    ] as const),
    SERVER_PORT: z
      .string()
      .regex(/^\d+$/, 'SERVER_PORT must be a valid integer string'),
    CLIENT_NAME: z.string().optional(),
    // Decision 130: REQUIRED — the client's business timezone (IANA name).
    // Declared, never inferred (a fallback zone is a wrong bill); validity
    // is asserted by initializeClientClock below.
    CLIENT_TIMEZONE: z.string().min(1, 'CLIENT_TIMEZONE is required (decision 130)'),
    // Canonical khal consumer surface (ADR-97): discovery + tenant resolve
    // the Auth System URL at runtime; the credential authenticates
    // /introspect. AUTH_SYSTEM_* below are the pre-discovery spellings.
    KHAL_DISCOVERY_URL: optionalNonEmptyString,
    KHAL_TENANT: optionalNonEmptyString,
    KHAL_CLIENT_ID: optionalNonEmptyString,
    KHAL_CLIENT_SECRET: optionalNonEmptyString,
    AUTH_SYSTEM_URL: optionalNonEmptyString,
    // audit D-1: cross-origin is an explicit operator act — exact origins,
    // comma-separated; unset/empty = same-origin only (no CORS headers).
    CORS_ALLOWED_ORIGINS: optionalNonEmptyString,
    AUTH_SYSTEM_CLIENT_ID: optionalNonEmptyString,
    AUTH_SYSTEM_CLIENT_SECRET: optionalNonEmptyString,
    // Decision 131: knobs of the opt-in billing-close scheduler. Bounds:
    // delay up to 7 days, interval up to 24h — beyond either the operator
    // wants a different mechanism, not a bigger number.
    BILLING_AUTO_CLOSE_DELAY_MINUTES: optionalBoundedIntString(
      'BILLING_AUTO_CLOSE_DELAY_MINUTES',
      10_080,
    ),
    BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS: optionalBoundedIntString(
      'BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS',
      86_400,
    ),
    // audit C-6: the Mongo env is core's — one reader for both images.
    ...mongoEnvSchemaShape,
  })
  .transform((env) => ({
    ...env,
    SERVER_PORT: parseInt(env.SERVER_PORT, 10),
    BILLING_AUTO_CLOSE_DELAY_MINUTES: env.BILLING_AUTO_CLOSE_DELAY_MINUTES
      ? parseInt(env.BILLING_AUTO_CLOSE_DELAY_MINUTES, 10)
      : undefined,
    BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS:
      env.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS
        ? parseInt(env.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS, 10)
        : undefined,
  }));

const narrowedEnv = Object.values(environmentEnum).includes(
  process.env.ENVIRONMENT as Environment,
)
  ? (process.env.ENVIRONMENT as Environment)
  : environmentEnum.DEVELOPMENT;

dotenv.config({
  path: path.resolve(process.cwd(), `.env.${narrowedEnv}`),
});

const unsafeEnv = process.env as Record<string, string>;

const parsedEnv = envSchema.safeParse(unsafeEnv);

if (!parsedEnv.success) {
  console.error('Invalid environment variables:', parsedEnv.error);
  process.exit(1);
}

const safeEnvironment = parsedEnv.data;

// Decision 130: one clock for billing boundary AND display, initialized
// at boot — every entry point imports this module before any date math.
initializeClientClock(safeEnvironment.CLIENT_TIMEZONE);

export const environment: EnvironmentVariables = {
  Environment: safeEnvironment.ENVIRONMENT,
  serverPort: safeEnvironment.SERVER_PORT,
  clientName: safeEnvironment.CLIENT_NAME || undefined,
  clientTimezone: safeEnvironment.CLIENT_TIMEZONE,
  // '' → undefined already guaranteed by optionalNonEmptyString above.
  khalDiscoveryUrl: safeEnvironment.KHAL_DISCOVERY_URL,
  khalTenant: safeEnvironment.KHAL_TENANT,
  authSystemUrl: safeEnvironment.AUTH_SYSTEM_URL,
  corsAllowedOrigins: safeEnvironment.CORS_ALLOWED_ORIGINS,
  // One credential, two spellings — the canonical KHAL_* wins when both are set.
  khalClientId: safeEnvironment.KHAL_CLIENT_ID ?? safeEnvironment.AUTH_SYSTEM_CLIENT_ID,
  khalClientSecret:
    safeEnvironment.KHAL_CLIENT_SECRET ?? safeEnvironment.AUTH_SYSTEM_CLIENT_SECRET,
  billingAutoCloseDelayMinutes: safeEnvironment.BILLING_AUTO_CLOSE_DELAY_MINUTES,
  billingAutoCloseCheckIntervalSeconds:
    safeEnvironment.BILLING_AUTO_CLOSE_CHECK_INTERVAL_SECONDS,
  ...toMongoDbEnvironment(safeEnvironment),
};
