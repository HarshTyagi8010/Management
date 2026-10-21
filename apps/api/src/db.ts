import mongoose, { type Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { DependencyStatus } from '@bizmgmt/contracts';
import { createModels, type Models } from './models.js';

// Reject unknown filter keys and neutralise `$`-operators supplied inside filter values.
// Operators written by our own code must be wrapped in `mongoose.trusted()`.
mongoose.set('strictQuery', true);
mongoose.set('sanitizeFilter', true);

export interface Database {
  check(): Promise<DependencyStatus>;
  close(): Promise<void>;
}

/** No database configured (allowed outside production in Phase 1): readiness reports "skipped". */
export const noDatabase: Database = {
  check: async () => 'skipped',
  close: async () => {},
};

export interface ConnectedDatabase extends Database {
  connection: Connection;
  models: Models;
}

export async function connectDatabase(uri: string, dbName: string, logger: Logger): Promise<ConnectedDatabase> {
  const connection = await mongoose
    .createConnection(uri, {
      dbName,
      serverSelectionTimeoutMS: 5_000,
      // Financial writes rely on majority-acknowledged writes (docs/architecture/architecture.md §6).
      writeConcern: { w: 'majority' },
      readConcern: { level: 'majority' },
    })
    .asPromise();
  logger.info({ dbName }, 'database connected');

  return {
    connection,
    models: createModels(connection),
    async check() {
      if (connection.readyState !== 1 || !connection.db) return 'down';
      await connection.db.admin().ping();
      return 'up';
    },
    async close() {
      await connection.close();
    },
  };
}
