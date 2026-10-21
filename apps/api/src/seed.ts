import { randomBytes } from 'node:crypto';
import { gstinCheckCharacter } from '@bizmgmt/contracts';
import { ConfigError, loadConfig } from './config.js';
import { connectDatabase } from './db.js';
import { createLogger } from './logger.js';
import { runMigrations } from './migrations/index.js';
import { buildModules } from './modules/index.js';
import { withTransaction } from './platform/transactions.js';

/**
 * `npm run db:seed`: a demo business with clearly synthetic data, for development
 * only. It contains no real people, businesses or identifiers (PAN and GSTINs are
 * made up but well formed), and deliberately ships **no tax rates**: rates must be
 * added with a verified source (GST-11).
 */
const DEMO_EMAIL = 'demo.owner@example.test';

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : 'Failed to load configuration');
    process.exit(1);
  }
  if (config.nodeEnv === 'production') {
    console.error('Refusing to seed demo data in production.');
    process.exit(1);
  }
  if (!config.mongodbUri) {
    console.error('MONGODB_URI is required (run `npm run dev:db` for a local replica set).');
    process.exit(1);
  }
  const logger = createLogger({ level: 'warn', service: 'seed' });
  const db = await connectDatabase(config.mongodbUri, config.mongodbDbName, logger);
  try {
    await runMigrations(db.connection, db.models, logger);
    if (await db.models.User.exists({ email: DEMO_EMAIL })) {
      console.log(`Demo data already exists (${DEMO_EMAIL}). Nothing to do.`);
      return;
    }
    const { identity, tenancy, organization, catalogue, parties } = await buildModules({ config, logger, db });
    const meta = { ipHash: 'seed', userAgent: 'seed script', requestId: `seed-${Date.now()}` };
    const password = `Demo-${randomBytes(9).toString('base64url')}`;

    const { userId, tenantId } = await withTransaction(db.connection, async (s) => {
      const user = await identity.createUser({ name: 'Demo Owner (sample)', email: DEMO_EMAIL, password, emailVerified: true }, s);
      const tenant = await tenancy.createTenantWithOwner(user._id, 'Demo Traders (sample)', meta, s);
      await catalogue.seedUnits(tenant, s);
      await db.models.User.updateOne({ _id: user._id }, { $set: { lastTenantId: tenant } }, { session: s });
      return { userId: user._id, tenantId: tenant };
    });
    const ctx = await tenancy.loadContext(userId, tenantId);
    if (!ctx) throw new Error('Demo owner context missing');

    // Synthetic identifiers: well formed, not issued to anyone.
    const pan = 'ZZZCD0001Z';
    const gstinBody = `27${pan}1Z`;
    const address = { line1: '1 Sample Industrial Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
    const entity = await organization.createEntity(
      ctx,
      { legalName: 'Demo Traders Private Limited (sample)', tradeName: 'Demo Traders', pan, constitution: 'private_limited', address, email: 'accounts@example.test', phone: '', turnoverBand: 'up_to_5cr' },
      meta,
    );
    const reg = await organization.createRegistration(
      ctx,
      entity.id,
      { gstin: gstinBody + gstinCheckCharacter(gstinBody), registrationType: 'regular', effectiveFrom: '2017-07-01', effectiveTo: null, address, label: 'Mumbai head office' },
      meta,
    );
    await organization.createSeries(ctx, { legalEntityId: entity.id, gstRegistrationId: reg.id, docType: 'tax_invoice', name: 'Tax invoices', prefix: 'INV/{FY}/', padding: 4, startNumber: 1, isDefault: true }, meta);
    await organization.createSeries(ctx, { legalEntityId: entity.id, gstRegistrationId: null, docType: 'quotation', name: 'Quotations', prefix: 'QT/{FY}/', padding: 4, startNumber: 1, isDefault: true }, meta);

    const fasteners = await catalogue.createCategory(ctx, { name: 'Fasteners' }, meta);
    const tools = await catalogue.createCategory(ctx, { name: 'Hand tools' }, meta);
    const note = 'Sample class with no rate. Add the GST rate and its source before invoicing.';
    const goods = await catalogue.createTaxClass(ctx, { name: 'Sample goods (no rate yet)', kind: 'goods', treatment: 'taxable', reverseCharge: false, description: note }, meta);
    const services = await catalogue.createTaxClass(ctx, { name: 'Sample services (no rate yet)', kind: 'service', treatment: 'taxable', reverseCharge: false, description: note }, meta);
    const units = await catalogue.listUnits(ctx);
    const unit = (code: string) => units.find((u) => u.code === code)?.id ?? '';
    const item = (sku: string, name: string, categoryId: string, salePrice: string, purchasePrice: string, extra: Record<string, unknown> = {}) =>
      catalogue.createItem(
        ctx,
        { sku, name, description: '', type: 'stock', categoryId, baseUnitId: unit('PCS'), altUnits: [{ unitId: unit('BOX'), factor: '100' }], hsnSac: '7318', taxClassId: goods.id, salePrice, purchasePrice, reorderLevel: '500', ...extra },
        meta,
      );
    await item('SMP-BOLT-M8', 'Sample hex bolt M8 × 40', fasteners.id, '4.50', '3.10');
    await item('SMP-NUT-M8', 'Sample hex nut M8', fasteners.id, '1.20', '0.80');
    await item('SMP-SPANNER', 'Sample spanner set (8 pc)', tools.id, '850.00', '610.00', { altUnits: [], baseUnitId: unit('SET'), hsnSac: '8204', reorderLevel: '10' });
    await catalogue.createItem(
      ctx,
      { sku: 'SMP-REPAIR', name: 'Sample repair labour (per hour)', description: '', type: 'service', categoryId: null, baseUnitId: unit('HRS'), altUnits: [], hsnSac: '998729', taxClassId: services.id, salePrice: '600.00', purchasePrice: null, reorderLevel: null },
      meta,
    );

    const party = (name: string, roles: { isCustomer: boolean; isSupplier: boolean }, stateCode: string, pincode: string, city: string, panSeed: string) => {
      const partyPan = `ZZZ${panSeed}`;
      const body = `${stateCode}${partyPan}1Z`;
      return parties.create(
        ctx,
        {
          name,
          legalName: '',
          ...roles,
          pan: partyPan,
          gstins: [{ gstin: body + gstinCheckCharacter(body), addressId: 'main' }],
          addresses: [{ id: 'main', label: 'Main', isBilling: true, isShipping: true, line1: '10 Sample Market Road', line2: '', city, district: '', stateCode, pincode }],
          contacts: [{ id: 'c1', name: 'Sample Contact', designation: 'Purchase', phone: '', email: '' }],
          creditLimit: roles.isCustomer ? '200000.00' : null,
          paymentTermsDays: 30,
          tags: ['sample'],
          confirmDuplicates: false,
        },
        meta,
      );
    };
    const buyer = await party('Sample Buyers Mumbai (sample)', { isCustomer: true, isSupplier: false }, '27', '400002', 'Mumbai', 'FB0002Z');
    await party('Sample Retail Pune (sample)', { isCustomer: true, isSupplier: false }, '27', '411001', 'Pune', 'FR0003Z');
    await party('Sample Distributors Bengaluru (sample)', { isCustomer: true, isSupplier: true }, '29', '560001', 'Bengaluru', 'CD0004Z');
    await party('Sample Steel Suppliers Gujarat (sample)', { isCustomer: false, isSupplier: true }, '24', '380001', 'Ahmedabad', 'CS0005Z');
    await parties.createTask(ctx, buyer.id, { title: 'Follow up on sample quotation', details: '', dueDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), assigneeId: null }, meta);

    console.log(['Demo data created (synthetic; no tax rates).', `  Sign in: ${DEMO_EMAIL}`, `  Password: ${password}`, '  The password is shown only now. Re-run after deleting the database to get a new one.'].join('\n'));
  } finally {
    await db.close();
  }
}

void main();
