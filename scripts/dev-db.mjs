// `npm run dev:db`: a persistent single-node MongoDB replica set for local development.
// Binary: PROJECT_ROOT/.cache/mongodb-binaries. Data: PROJECT_ROOT/.artifacts/dev-db (git-ignored).
// Then run the API with MONGODB_URI=mongodb://127.0.0.1:27027/?replicaSet=rs0 (printed below).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

const ROOT = path.resolve(import.meta.dirname, '..');
const dbPath = path.join(ROOT, '.artifacts', 'dev-db');
const port = Number(process.env.DEV_DB_PORT ?? 27027);
mkdirSync(dbPath, { recursive: true });

const replSet = await MongoMemoryReplSet.create({
  binary: { version: '8.0.34', downloadDir: path.join(ROOT, '.cache', 'mongodb-binaries') },
  replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
  // Keep data between runs (no cleanup of a caller-provided dbPath).
  instanceOpts: [{ dbPath, port, launchTimeout: 60_000 }],
});

console.log(`Development MongoDB replica set ready.\n  MONGODB_URI=mongodb://127.0.0.1:${port}/?replicaSet=rs0\nData: ${dbPath}\nPress Ctrl+C to stop.`);

const stop = async () => {
  await replSet.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
