import { ConfigError, loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrations/index.js';

/** `npm run db:migrate`: applies pending migrations to MONGODB_URI / MONGODB_DB_NAME. */
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }
  const logger = createLogger({ level: config.logLevel, service: 'migrate' });
  if (!config.mongodbUri) {
    logger.error('MONGODB_URI is required');
    process.exit(1);
  }
  const db = await connectDatabase(config.mongodbUri, config.mongodbDbName, logger);
  try {
    const ran = await runMigrations(db.connection, db.models, logger);
    logger.info({ ran }, ran.length ? 'migrations applied' : 'database is up to date');
  } finally {
    await db.close();
  }
}

void main();
