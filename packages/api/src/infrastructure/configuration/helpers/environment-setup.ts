import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';
import {
  LangWatchEnvironmentVariables,
  MongoDbEnvironmentVariables,
  ServerEnvironmentVariables,
  TraceIngestionWorkerEnvironmentVariables,
} from '../interfaces/index.js';

const environmentEnum = {
  PRODUCTION: 'production',
  STAGING: 'staging',
  TEST: 'test',
  DEVELOPMENT: 'development',
} as const;

type Environment = (typeof environmentEnum)[keyof typeof environmentEnum];

export interface EnvironmentVariables
  extends
    ServerEnvironmentVariables,
    MongoDbEnvironmentVariables,
    LangWatchEnvironmentVariables,
    TraceIngestionWorkerEnvironmentVariables {
  Environment: Environment;
}

/** Optional positive-integer env string (worker knobs). */
const optionalIntString = (name: string) =>
  z
    .string()
    .regex(/^\d+$/, `${name} must be a valid integer string`)
    .optional();

const envSchema = z
  .object({
    ENVIRONMENT: z.enum([
      environmentEnum.PRODUCTION,
      environmentEnum.STAGING,
      environmentEnum.TEST,
      environmentEnum.DEVELOPMENT,
    ] as const),
    SERVER_PORT: z
      .string()
      .regex(/^\d+$/, 'SERVER_PORT must be a valid integer string'),
    CLIENT_NAME: z.string().optional(),
    MONGO_DB_PORT: z
      .string()
      .regex(/^\d+$/, 'MONGO_DB_PORT must be a valid integer string')
      .optional(),
    MONGO_DB_ATLAS: z.boolean().optional(),
    MONGO_DB_HOST: z.string().optional(),
    MONGO_DB_NAME: z.string().optional(),
    MONGO_DB_PASSWORD: z.string().optional(),
    MONGO_DB_USER: z.string().optional(),
    LANGWATCH_ENDPOINT: z.string().optional(),
    LANGWATCH_API_KEY: z.string().optional(),
    LANGWATCH_CLICKHOUSE_URL: z.string().optional(),
    LANGWATCH_CLICKHOUSE_USER: z.string().optional(),
    LANGWATCH_CLICKHOUSE_PASSWORD: z.string().optional(),
    LANGWATCH_CLICKHOUSE_DATABASE: z.string().optional(),
    LANGWATCH_PROJECT_ID: z.string().optional(),
    TRACE_INGESTION_INTERVAL_SECONDS: optionalIntString('TRACE_INGESTION_INTERVAL_SECONDS'),
    TRACE_INGESTION_BATCH_SIZE: optionalIntString('TRACE_INGESTION_BATCH_SIZE'),
    TRACE_INGESTION_QUIET_PERIOD_SECONDS: optionalIntString('TRACE_INGESTION_QUIET_PERIOD_SECONDS'),
    REPROCESS_INTERVAL_SECONDS: optionalIntString('REPROCESS_INTERVAL_SECONDS'),
  })
  .transform((env) => ({
    ...env,
    SERVER_PORT: parseInt(env.SERVER_PORT, 10),
    MONGO_DB_PORT: env.MONGO_DB_PORT
      ? parseInt(env.MONGO_DB_PORT, 10)
      : undefined,
    TRACE_INGESTION_INTERVAL_SECONDS: env.TRACE_INGESTION_INTERVAL_SECONDS
      ? parseInt(env.TRACE_INGESTION_INTERVAL_SECONDS, 10)
      : undefined,
    TRACE_INGESTION_BATCH_SIZE: env.TRACE_INGESTION_BATCH_SIZE
      ? parseInt(env.TRACE_INGESTION_BATCH_SIZE, 10)
      : undefined,
    TRACE_INGESTION_QUIET_PERIOD_SECONDS: env.TRACE_INGESTION_QUIET_PERIOD_SECONDS
      ? parseInt(env.TRACE_INGESTION_QUIET_PERIOD_SECONDS, 10)
      : undefined,
    REPROCESS_INTERVAL_SECONDS: env.REPROCESS_INTERVAL_SECONDS
      ? parseInt(env.REPROCESS_INTERVAL_SECONDS, 10)
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
  mongoDbAtlas: safeEnvironment.MONGO_DB_ATLAS,
  mongoDbHost: safeEnvironment.MONGO_DB_HOST,
  mongoDbName: safeEnvironment.MONGO_DB_NAME,
  mongoDbPassword: safeEnvironment.MONGO_DB_PASSWORD,
  mongoDbPort: safeEnvironment.MONGO_DB_PORT,
  mongoDbUser: safeEnvironment.MONGO_DB_USER,
  langwatchEndpoint: safeEnvironment.LANGWATCH_ENDPOINT,
  langwatchApiKey: safeEnvironment.LANGWATCH_API_KEY,
  langwatchClickhouseUrl: safeEnvironment.LANGWATCH_CLICKHOUSE_URL,
  langwatchClickhouseUser: safeEnvironment.LANGWATCH_CLICKHOUSE_USER,
  langwatchClickhousePassword: safeEnvironment.LANGWATCH_CLICKHOUSE_PASSWORD,
  langwatchClickhouseDatabase: safeEnvironment.LANGWATCH_CLICKHOUSE_DATABASE,
  langwatchProjectId: safeEnvironment.LANGWATCH_PROJECT_ID,
  traceIngestionIntervalSeconds: safeEnvironment.TRACE_INGESTION_INTERVAL_SECONDS,
  traceIngestionBatchSize: safeEnvironment.TRACE_INGESTION_BATCH_SIZE,
  traceIngestionQuietPeriodSeconds: safeEnvironment.TRACE_INGESTION_QUIET_PERIOD_SECONDS,
  reprocessIntervalSeconds: safeEnvironment.REPROCESS_INTERVAL_SECONDS,
};
