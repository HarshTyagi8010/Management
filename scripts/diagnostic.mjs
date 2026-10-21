import { MongoMemoryReplSet } from 'mongodb-memory-server-core';
import mongoose from 'mongoose';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const dbPath = path.join(ROOT, '.artifacts', 'dev-db');
const port = 27027;

console.log('--- SLICE 0 AUDIT-ONLY DIAGNOSTIC ---');

let replSet = null;
let connected = false;

try {
  await mongoose.connect(`mongodb://127.0.0.1:${port}/?replicaSet=rs0`, { serverSelectionTimeoutMS: 2000 });
  connected = true;
  console.log('Connected to running MongoDB on port 27027');
} catch {
  console.log('Starting MongoMemoryReplSet against .artifacts/dev-db...');
  try {
    replSet = await MongoMemoryReplSet.create({
      binary: { version: '8.0.34', downloadDir: path.join(ROOT, '.cache', 'mongodb-binaries') },
      replSet: { name: 'rs0', count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
      instanceOpts: [{ dbPath, port, launchTimeout: 60_000 }],
    });
    await mongoose.connect(replSet.getUri(), { dbName: 'bizmgmt_dev' });
    connected = true;
    console.log('Connected to dev replica set');
  } catch (err) {
    console.log('Could not connect to .artifacts/dev-db:', err.message);
  }
}

import { runFinancialDiagnostic } from './diagnostic-core.mjs';

if (connected) {
  const db = mongoose.connection.db;
  const res = await runFinancialDiagnostic(db);

  console.log(`Diagnostic Cutoff: ${res.cutoff}`);
  console.log(`Database: mongodb://127.0.0.1:${port}/bizmgmt_dev (credentials redacted)`);
  console.log(`Scope:`);
  console.log(`  - Tenants: ${res.scope.tenantsCount}`);
  console.log(`  - Legal Entities: ${res.scope.legalEntitiesCount}`);
  console.log(`  - Invoices: ${res.scope.invoicesCount}`);
  console.log(`  - Bills: ${res.scope.billsCount}`);
  console.log(`  - Payments: ${res.scope.paymentsCount}`);
  console.log(`  - Credit Notes: ${res.scope.creditNotesCount}`);
  console.log(`  - Debit Notes: ${res.scope.debitNotesCount}`);
  console.log(`  - Refunds: ${res.scope.refundsCount}`);
  console.log(`  - Journals: ${res.scope.journalsCount}`);
  console.log(`Issues Detected: ${res.issuesCount}`);
  for (const issue of res.issues) {
    console.log(`  [${issue.kind}] ${issue.detail}`);
  }

  if (replSet) {
    await replSet.stop({ doCleanup: false });
  }
  await mongoose.disconnect();
} else {
  console.log('Diagnostic skipped: No active database instances to inspect.');
}
console.log('--- DIAGNOSTIC COMPLETE ---');
process.exit(0);
