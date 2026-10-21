import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { connectDatabase, noDatabase, type Database } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrations/index.js';
import { buildModules } from './modules/index.js';
import type { Router } from 'express';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config errors never contain values, so printing the message is safe.
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }

  const logger = createLogger({ level: config.logLevel, service: 'api' });

  if (config.usingDevSecret) logger.warn('APP_SECRET not set: using the insecure development secret');

  let db: Database = noDatabase;
  let routers: Router[] = [];
  if (config.mongodbUri) {
    const connected = await connectDatabase(config.mongodbUri, config.mongodbDbName, logger);
    db = connected;
    // Production migrations are run deliberately (npm run db:migrate), never on start-up.
    if (config.nodeEnv !== 'production') await runMigrations(connected.connection, connected.models, logger);
    routers = (await buildModules({ config, logger, db: connected })).routers;
  } else {
    logger.warn('MONGODB_URI not set: running without a database; sign-in and all business routes are unavailable');
  }

  const app = createApp({ config, logger, readinessChecks: { database: () => db.check() }, routers });
  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => {
      db.close()
        .catch((err: unknown) => logger.error({ err }, 'error closing database'))
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

void main();
