/**
 * Storage-lifecycle port consumed by the composition root (main/index and
 * the one-off jobs). A backend adapter is a ready-to-connect handle with
 * its configuration already applied by the factory — entry points never
 * see connection details or a concrete driver class.
 */
export interface Database {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Schema-migration port: applies the backend's own migration catalog once,
 * in order, and reports the ids it applied. Each backend owns its catalog
 * (Mongo's lives in infrastructure/database/mongodb/migrations); the
 * runner job in main is backend-blind.
 */
export interface MigrationRunner {
  run(): Promise<string[]>;
}
