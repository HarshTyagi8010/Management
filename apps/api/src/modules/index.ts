import { Router } from 'express';
import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { ConnectedDatabase } from '../db.js';
import { Csrf, sessionMiddleware } from '../middleware/auth.js';
import { deriveKeyring } from '../platform/crypto.js';
import { createMailer, type Mailer } from '../platform/mailer.js';
import { Throttle } from '../platform/rate-limit.js';
import { AuditLog } from './audit/audit.js';
import { IdentityService } from './identity/identity.js';
import { createPasswordHasher } from './identity/passwords.js';
import { authRouter } from './identity/routes.js';
import { TenancyService } from './tenancy/tenancy.js';
import { tenancyRouter } from './tenancy/routes.js';
import { CatalogueService } from './catalogue/catalogue.js';
import { catalogueRouter } from './catalogue/routes.js';
import { OrganizationService } from './organization/organization.js';
import { organizationRouter } from './organization/routes.js';
import { PartiesService } from './parties/parties.js';
import { partiesRouter } from './parties/routes.js';
import { InventoryService } from './inventory/inventory.js';
import { StockLedger } from './inventory/ledger.js';
import { inventoryRouter } from './inventory/routes.js';
import { JournalService } from './finance/journals.js';
import { NumberingService } from './finance/numbering.js';
import { PreviewService } from './finance/preview.js';
import { financeRouter } from './finance/routes.js';
import { createStorage } from '../platform/storage-factory.js';
import { SalesCore } from './sales/core.js';
import { DispatchService } from './sales/dispatches.js';
import { SalesInvoiceService } from './sales/invoices.js';
import { SalesOrderService } from './sales/orders.js';
import { QuotationService } from './sales/quotations.js';
import { salesRouter } from './sales/routes.js';
import { PurchaseOrderService } from './purchases/orders.js';
import { GoodsReceiptService } from './purchases/receipts.js';
import { SupplierBillService } from './purchases/bills.js';
import { purchasesRouter } from './purchases/routes.js';
import { PaymentService } from './payments/payments.js';
import { ExpenseService } from './payments/expenses.js';
import { NoteService } from './payments/notes.js';
import { StatementService } from './payments/statements.js';
import { paymentsRouter } from './payments/routes.js';

export interface ModuleOptions {
  config: AppConfig;
  logger: Logger;
  db: ConnectedDatabase;
  /** Overrides the configured transport (tests capture mail in memory). */
  mailer?: Mailer;
  now?: () => Date;
}

/**
 * Wires the business modules. The first router resolves the session and
 * enforces CSRF for everything mounted after it.
 */
export async function buildModules({ config, logger, db, mailer: mailerOverride, now }: ModuleOptions) {
  const { connection, models } = db;
  const keys = deriveKeyring(config.appSecret);
  const hasher = await createPasswordHasher(config.passwordHashProfile);
  const mailer = mailerOverride ?? createMailer(config.mail);
  const audit = new AuditLog(models);
  const throttle = new Throttle(models, now);
  const identity = new IdentityService({ config, connection, models, hasher, keys, mailer, audit, throttle, logger, ...(now ? { now } : {}) });
  const tenancy = new TenancyService({ config, connection, models, audit, mailer, identity, ...(now ? { now } : {}) });
  const clock = now ? { now } : {};
  const journals = new JournalService(models);
  const numbering = new NumberingService(models);
  const preview = new PreviewService(models);
  const storage = createStorage(config.storage);
  const organization = new OrganizationService({ models, audit, journals, storage, ...clock });
  const catalogue = new CatalogueService({ models, audit, ...clock });
  const parties = new PartiesService({ models, audit, ...clock });
  const inventory = new InventoryService({ connection, models, audit, journals, storage, ...clock });
  const sales = new SalesCore({ connection, models, audit, journals, numbering, preview, storage, now });
  const quotations = new QuotationService(sales);
  const orders = new SalesOrderService(sales);
  const dispatches = new DispatchService(sales);
  const invoices = new SalesInvoiceService(sales);
  const purchaseOrders = new PurchaseOrderService(models, audit, numbering, storage);
  const ledger = new StockLedger(models);
  const goodsReceipts = new GoodsReceiptService(models, audit, numbering, ledger);
  const supplierBills = new SupplierBillService(models, audit, numbering, journals, ledger);
  const paymentServices = { models, audit, numbering, journals, ledger };
  const payments = new PaymentService(paymentServices);
  const expenses = new ExpenseService(paymentServices);
  const notes = new NoteService(paymentServices);
  const statements = new StatementService(paymentServices);
  const csrf = new Csrf(keys);

  const security = Router();
  security.use(sessionMiddleware(identity));
  security.use(csrf.middleware(config));

  return {
    routers: [
      security,
      authRouter({ config, connection, models, identity, tenancy, catalogue, csrf, throttle }),
      tenancyRouter({ config, identity, tenancy, audit, now }),
      organizationRouter({ config, identity, tenancy, organization }),
      catalogueRouter({ config, identity, tenancy, catalogue }),
      partiesRouter({ config, identity, tenancy, parties }),
      inventoryRouter({ config, models, now, identity, tenancy, inventory }),
      financeRouter({ config, models, tenancy, journals, preview, now }),
      salesRouter({ config, models, now, identity, tenancy, core: sales, quotations, orders, dispatches, invoices }),
      purchasesRouter({ config, models, now, identity, tenancy, orders: purchaseOrders, receipts: goodsReceipts, bills: supplierBills }),
      paymentsRouter({ config, models, now, identity, tenancy, payments, expenses, notes, statements }),
    ],
    identity,
    tenancy,
    organization,
    catalogue,
    parties,
    inventory,
    journals,
    numbering,
    sales: { core: sales, quotations, orders, dispatches, invoices },
    purchases: { orders: purchaseOrders, receipts: goodsReceipts, bills: supplierBills },
    payments: { payments, expenses, notes, statements },
    storage,
    mailer,
  };
}

