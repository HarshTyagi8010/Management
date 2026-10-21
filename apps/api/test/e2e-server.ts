import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { connectDatabase } from '../src/db.js';
import { createLogger } from '../src/logger.js';
import { runMigrations } from '../src/migrations/index.js';
import { buildModules } from '../src/modules/index.js';
import { buildWorkerTasks } from '../src/jobs/index.js';
import { MONGODB_VERSION } from './global-setup.js';

/**
 * API for the Playwright suite: a throwaway replica set (PROJECT_ROOT/.tmp) and
 * the real app with test settings. Started by apps/web/playwright.config.ts.
 */
const ROOT = path.resolve(import.meta.dirname, '../../..');
const port = Number(process.env.E2E_API_PORT ?? 4100);
const TMP = path.join(ROOT, '.tmp');
const dbPath = path.join(TMP, `mongo-e2e-${process.pid}`);
const storageDir = path.join(TMP, `storage-e2e-${process.pid}`);

/** On Windows the runner ends this process without a signal, so earlier runs could not clean up. Remove their data. */
function removeStaleRuns() {
  let names: string[];
  try {
    names = readdirSync(TMP);
  } catch {
    return;
  }
  for (const name of names) {
    const pid = Number(/^(?:mongo|storage)-e2e-(\d+)$/.exec(name)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // still running
    } catch {
      rmSync(path.join(TMP, name), { recursive: true, force: true });
    }
  }
}
removeStaleRuns();
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  binary: { version: MONGODB_VERSION, downloadDir: path.join(ROOT, '.cache', 'mongodb-binaries') },
  replSet: { count: 1, storageEngine: 'wiredTiger' },
  instanceOpts: [{ dbPath, launchTimeout: 60_000 }],
});

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'warn',
  PORT: String(port),
  PASSWORD_HASH_PROFILE: 'test',
  MONGODB_URI: replSet.getUri(),
  MONGODB_DB_NAME: 'bizmgmt_e2e',
  APP_SECRET: 'e2e-test-secret-not-for-production-0123456789',
  CORS_ORIGINS: 'http://127.0.0.1:4173',
  PUBLIC_APP_URL: 'http://127.0.0.1:4173',
  STORAGE_DIR: storageDir,
});
const logger = createLogger({ level: config.logLevel, service: 'api-e2e' });
const db = await connectDatabase(replSet.getUri(), config.mongodbDbName, logger);
await runMigrations(db.connection, db.models);
const { routers } = await buildModules({ config, logger, db });
// The worker's tasks run in this process during E2E (outbox → transfer note PDFs).
const tasks = buildWorkerTasks({ config, db, logger, integrityIntervalMs: 60_000 });
const controller = new AbortController();
let working = false;
const workTimer = setInterval(() => {
  if (working) return;
  working = true;
  void (async () => {
    for (const task of tasks) {
      while (!controller.signal.aborted && (await task.runOnce(controller.signal).catch(() => false))) {
        // keep going while there is work
      }
    }
  })().finally(() => {
    working = false;
  });
}, 500);

const server = createApp({ config, logger, readinessChecks: { database: () => db.check() }, routers }).listen(port, '127.0.0.1', () => {
  console.log(`e2e api listening on 127.0.0.1:${port}`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  controller.abort();
  clearInterval(workTimer);
  server.close();
  await db.close().catch(() => undefined);
  await replSet.stop({ doCleanup: true, force: true }).catch(() => undefined);
  rmSync(dbPath, { recursive: true, force: true });
  rmSync(storageDir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
