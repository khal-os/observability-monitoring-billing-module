import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import {
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
  extends ServerEnvironmentVariables, MongoDbEnvironmentVariables {
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
    AUTH_SYSTEM_URL: optionalNonEmptyString,
    // audit D-1: cross-origin is an explicit operator act — exact origins,
    // comma-separated; unset/empty = same-origin only (no CORS headers).
    CORS_ALLOWED_ORIGINS: optionalNonEmptyString,
    AUTH_SYSTEM_CLIENT_ID: optionalNonEmptyString,
    AUTH_SYSTEM_CLIENT_SECRET: optionalNonEmptyString,
    MONGO_DB_PORT: z
      .string()
      .regex(/^\d+$/, 'MONGO_DB_PORT must be a valid integer string')
      .optional(),
    // env vars are always strings — a boolean here would reject every set
    // value and crash the boot; the transform below maps to boolean.
    MONGO_DB_ATLAS: z.enum(['true', 'false']).optional(),
    MONGO_DB_HOST: z.string().optional(),
    MONGO_DB_NAME: z.string().optional(),
    MONGO_DB_PASSWORD: z.string().optional(),
    MONGO_DB_USER: z.string().optional(),
  })
  .transform((env) => ({
    ...env,
    SERVER_PORT: parseInt(env.SERVER_PORT, 10),
    MONGO_DB_PORT: env.MONGO_DB_PORT
      ? parseInt(env.MONGO_DB_PORT, 10)
      : undefined,
    MONGO_DB_ATLAS: env.MONGO_DB_ATLAS
      ? env.MONGO_DB_ATLAS === 'true'
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

export const environment: EnvironmentVariables = {
  Environment: safeEnvironment.ENVIRONMENT,
  serverPort: safeEnvironment.SERVER_PORT,
  clientName: safeEnvironment.CLIENT_NAME || undefined,
  // '' → undefined already guaranteed by optionalNonEmptyString above.
  authSystemUrl: safeEnvironment.AUTH_SYSTEM_URL,
  corsAllowedOrigins: safeEnvironment.CORS_ALLOWED_ORIGINS,
  authSystemClientId: safeEnvironment.AUTH_SYSTEM_CLIENT_ID,
  authSystemClientSecret: safeEnvironment.AUTH_SYSTEM_CLIENT_SECRET,
  mongoDbAtlas: safeEnvironment.MONGO_DB_ATLAS,
  mongoDbHost: safeEnvironment.MONGO_DB_HOST,
  mongoDbName: safeEnvironment.MONGO_DB_NAME,
  mongoDbPassword: safeEnvironment.MONGO_DB_PASSWORD,
  mongoDbPort: safeEnvironment.MONGO_DB_PORT,
  mongoDbUser: safeEnvironment.MONGO_DB_USER,
};
