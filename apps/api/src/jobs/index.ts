import type { Logger } from 'pino';
import { loadConfig, type AppConfig } from '../config.js';
import { connectDatabase, type ConnectedDatabase } from '../db.js';
import { createStorage } from '../platform/storage-factory.js';
import { outboxConsumer, type WorkerTask } from './outbox.js';
import { renderDocumentHandler } from './render.js';
import { integrityJobs, salesJobs, scheduler } from './scheduler.js';

export type { WorkerTask } from './outbox.js';
export { outboxConsumer } from './outbox.js';
export { integrityJobs, salesJobs, scheduler } from './scheduler.js';

export const INTEGRITY_INTERVAL_MS = 24 * 3_600_000;

/** The worker's tasks over an open database (also used by tests with their own clock). */
export function buildWorkerTasks(deps: { config: AppConfig; db: ConnectedDatabase; logger: Logger; now?: () => Date; integrityIntervalMs?: number }): WorkerTask[] {
  const { models } = deps.db;
  const storage = createStorage(deps.config.storage);
  const clock = deps.now ? { now: deps.now } : {};
  return [
    outboxConsumer({ models, logger: deps.logger, handlers: { 'document.render': renderDocumentHandler({ models, storage, ...clock }) }, ...clock }),
    scheduler({
      models,
      logger: deps.logger,
      jobs: [...integrityJobs({ models, logger: deps.logger, intervalMs: deps.integrityIntervalMs ?? INTEGRITY_INTERVAL_MS, ...clock }), ...salesJobs({ models, logger: deps.logger, intervalMs: deps.integrityIntervalMs ?? INTEGRITY_INTERVAL_MS, ...clock })],
      ...clock,
    }),
  ];
}

/** Connects with the API's configuration (same environment variables) and returns the tasks. */
export async function startJobRuntime(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<{ tasks: WorkerTask[]; close: () => Promise<void> }> {
  const config = loadConfig(env);
  if (!config.mongodbUri) {
    logger.warn('MONGODB_URI is not set: the worker runs without tasks');
    return { tasks: [], close: async () => {} };
  }
  const db = await connectDatabase(config.mongodbUri, config.mongodbDbName, logger);
  return { tasks: buildWorkerTasks({ config, db, logger }), close: () => db.close() };
}
