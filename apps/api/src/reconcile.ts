import { ConfigError, loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { createLogger } from './logger.js';
import { reconcileStock } from './modules/inventory/reconciliation.js';

/**
 * `npm run stock:reconcile`: stock reconciliation over every business (FR-INV-09, AC-INV-2).
 * Read-only. Logs the differences per business and exits 1 when any drift is
 * found, so a scheduler or the restore drill can alert on it (operations.md).
 * The worker runs it on a schedule from Phase 6.
 */
async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(2);
  }
  const logger = createLogger({ level: config.logLevel, service: 'reconcile' });
  if (!config.mongodbUri) {
    logger.error('MONGODB_URI is required');
    process.exit(2);
  }
  const db = await connectDatabase(config.mongodbUri, config.mongodbDbName, logger);
  let drift = 0;
  try {
    const tenants = await db.models.Tenant.find({}, { _id: 1 }).lean();
    let negative = 0;
    for (const { _id: tenantId } of tenants) {
      const result = await reconcileStock(db.models, tenantId, 'all');
      drift += result.issues.length;
      negative += result.negativeBalances.length;
      if (result.issues.length || result.negativeBalances.length) {
        logger.warn(
          {
            tenantId: tenantId.toHexString(),
            issues: result.issues.map((i) => ({ kind: i.kind, warehouseId: i.warehouseId?.toHexString() ?? null, itemId: i.itemId.toHexString(), expected: i.expected, actual: i.actual })),
            negativeBalances: result.negativeBalances.length,
          },
          'stock reconciliation found differences',
        );
      }
    }
    logger.info({ tenants: tenants.length, drift, negativeBalances: negative }, drift ? 'stock reconciliation: drift found' : 'stock reconciliation: no drift');
  } finally {
    await db.close();
  }
  process.exit(drift ? 1 : 0);
}

void main();
