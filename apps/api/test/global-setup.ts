import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import type { TestProject } from 'vitest/node';

/**
 * Starts a single-node MongoDB replica set (transactions need a replica set) for
 * the integration suite, unless MONGODB_URI_TEST points at one. Binary and data
 * stay inside PROJECT_ROOT: .cache/mongodb-binaries and .tmp/mongo-test-<pid>.
 */
const ROOT = path.resolve(import.meta.dirname, '../../..');
export const MONGODB_VERSION = '8.0.34';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject) {
  const external = process.env.MONGODB_URI_TEST;
  if (external) {
    project.provide('mongoUri', external);
    return;
  }
  const dbPath = path.join(ROOT, '.tmp', `mongo-test-${process.pid}`);
  mkdirSync(dbPath, { recursive: true });
  const replSet = await MongoMemoryReplSet.create({
    binary: { version: MONGODB_VERSION, downloadDir: path.join(ROOT, '.cache', 'mongodb-binaries') },
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    // mongod can be slow to start on a busy machine (the library default is 10 s).
    instanceOpts: [{ dbPath, launchTimeout: 60_000 }],
  });
  project.provide('mongoUri', replSet.getUri());
  return async () => {
    await replSet.stop({ doCleanup: true, force: true });
    rmSync(dbPath, { recursive: true, force: true });
  };
}
