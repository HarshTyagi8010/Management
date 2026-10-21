import type { Connection } from 'mongoose';
import type { Logger } from 'pino';
import { Types } from 'mongoose';
import { DEFAULT_UNITS, MOVEMENT_KINDS } from '@bizmgmt/contracts';
import { JournalService, stockJournalLines } from '../modules/finance/journals.js';
import { withTransaction } from '../platform/transactions.js';
import type { Models } from '../models.js';

/** createCollection fails with NamespaceExists (48) on a re-run; that is fine. */
async function ensureCollections(models: Models) {
  for (const model of Object.values(models)) {
    await model.createCollection().catch((err: { code?: number }) => {
      if (err.code !== 48) throw err;
    });
    await model.createIndexes();
  }
}

export interface Migration {
  id: string;
  description: string;
  up(context: { connection: Connection; models: Models }): Promise<void>;
}

/** Ordered list; never edit or reorder a migration that has run anywhere — add a new one. */
export const MIGRATIONS: Migration[] = [
  {
    id: '001-identity-tenancy-audit',
    description: 'Create identity, tenancy and audit collections with their indexes',
    async up({ models }) {
      await ensureCollections(models);
    },
  },
  {
    id: '002-organization-catalogue-parties',
    description: 'Create organization, catalogue, party and CRM collections; give existing businesses the default units',
    async up({ models }) {
      await ensureCollections(models);
      const tenants = await models.Tenant.find({}, { _id: 1 }).lean();
      for (const { _id: tenantId } of tenants) {
        if ((await models.Unit.countDocuments({ tenantId })) > 0) continue;
        await models.Unit.insertMany(DEFAULT_UNITS.map(([code, name, uqc, decimals]) => ({ tenantId, code, name, uqc, decimals, archivedAt: null, version: 0 })));
      }
    },
  },
  {
    id: '003-inventory',
    description: 'Create warehouse and stock collections; add $jsonSchema validators to the stock ledger, balances and valuations',
    async up({ connection, models }) {
      await ensureCollections(models);
      const db = connection.db;
      if (!db) throw new Error('Database connection is not open');
      // Database-level guard in addition to Mongoose (schema.md conventions): wrong types are refused even from other clients.
      const decimal = { bsonType: 'decimal' };
      const id = { bsonType: 'objectId' };
      const validators: Record<string, Record<string, unknown>> = {
        stockMovements: {
          bsonType: 'object',
          required: ['tenantId', 'legalEntityId', 'warehouseId', 'itemId', 'kind', 'qty', 'onHandAfter', 'unitCost', 'value', 'sourceType', 'sourceId', 'sourceLineId', 'docDate', 'createdAt'],
          properties: {
            tenantId: id,
            legalEntityId: id,
            warehouseId: id,
            itemId: id,
            kind: { enum: [...MOVEMENT_KINDS] },
            qty: decimal,
            onHandAfter: decimal,
            unitCost: decimal,
            value: decimal,
            docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
        },
        stockBalances: { bsonType: 'object', required: ['tenantId', 'legalEntityId', 'warehouseId', 'itemId', 'onHand', 'reserved', 'inTransit'], properties: { onHand: decimal, reserved: decimal, inTransit: decimal } },
        itemValuations: { bsonType: 'object', required: ['tenantId', 'legalEntityId', 'itemId', 'qty', 'value'], properties: { qty: decimal, value: decimal, avgCost: { bsonType: ['decimal', 'null'] } } },
      };
      for (const [collection, schema] of Object.entries(validators)) {
        await db.command({ collMod: collection, validator: { $jsonSchema: schema }, validationLevel: 'strict', validationAction: 'error' });
      }
    },
  },
  {
    id: '004-financial-engine',
    description: 'Create financial-engine collections, validate journals, give every business entity its accounts, and post journals for stock already posted',
    async up({ connection, models }) {
      await ensureCollections(models);
      const db = connection.db;
      if (!db) throw new Error('Database connection is not open');
      const decimal = { bsonType: 'decimal' };
      await db.command({
        collMod: 'journals',
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['tenantId', 'legalEntityId', 'docDate', 'sourceType', 'sourceId', 'lines', 'totalDebit', 'totalCredit', 'createdAt'],
            properties: {
              docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              lines: { bsonType: 'array', minItems: 2, items: { bsonType: 'object', required: ['accountId', 'accountCode', 'debit', 'credit'], properties: { debit: decimal, credit: decimal } } },
              totalDebit: decimal,
              totalCredit: decimal,
            },
          },
        },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      const journals = new JournalService(models);
      for (const entity of await models.LegalEntity.find({}, { tenantId: 1 }).setOptions({ crossTenantReason: 'migration over every business' }).lean()) {
        await journals.ensureAccounts(entity.tenantId, entity._id);
      }
      // Stock posted before journals existed (Phase 5): one journal per document, built from its movements.
      const sources = await models.StockMovement.aggregate<{ _id: { t: Types.ObjectId; type: string; id: Types.ObjectId }; e: Types.ObjectId; number: string; docDate: string; by: Types.ObjectId; at: Date; moves: Array<{ kind: string; value: unknown }> }>([
        { $match: { tenantId: { $exists: true }, sourceType: { $in: ['stock_adjustment', 'stock_count'] } } },
        { $sort: { _id: 1 } },
        { $group: { _id: { t: '$tenantId', type: '$sourceType', id: '$sourceId' }, e: { $first: '$legalEntityId' }, number: { $first: '$sourceNumber' }, docDate: { $first: '$docDate' }, by: { $first: '$createdBy' }, at: { $first: '$createdAt' }, moves: { $push: { kind: '$kind', value: '$value' } } } },
      ]);
      for (const s of sources) {
        if (await models.Journal.exists({ tenantId: s._id.t, sourceType: s._id.type, sourceId: s._id.id, reversalOf: null })) continue;
        await withTransaction(connection, (session) =>
          journals.post(session, {
            tenantId: s._id.t,
            legalEntityId: s.e,
            docDate: s.docDate,
            sourceType: s._id.type as 'stock_adjustment' | 'stock_count',
            sourceId: s._id.id,
            sourceNumber: s.number,
            narration: `${s.number} (journal added by migration 004)`,
            lines: stockJournalLines(s.moves.map((m) => ({ kind: m.kind, value: String(m.value) }))),
            actorId: s.by,
            now: s.at,
          }),
        );
      }
    },
  },
  {
    id: '005-order-to-cash',
    description: 'Create quotation, sales order, dispatch and sales invoice collections with $jsonSchema validators; add the logo field to business entities',
    async up({ connection, models }) {
      await ensureCollections(models);
      const db = connection.db;
      if (!db) throw new Error('Database connection is not open');
      const decimal = { bsonType: 'decimal' };
      const decimalOrNull = { bsonType: ['decimal', 'null'] };
      const totals = ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'reverseChargeTax', 'subtotal', 'roundOff', 'grand'];
      const amounts = ['gross', 'discount', 'net', 'documentDiscount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'total'];
      // Same shape for the four sales collections: money and quantities must be Decimal128, numbers are strings.
      const validator = {
        $jsonSchema: {
          bsonType: 'object',
          required: ['tenantId', 'legalEntityId', 'gstRegistrationId', 'docType', 'documentKind', 'status', 'docDate', 'partyId', 'lines', 'totals', 'documentDiscount', 'calcVersion'],
          properties: {
            docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            number: { bsonType: ['string', 'null'] },
            documentDiscount: decimal,
            outstanding: decimalOrNull,
            totals: { bsonType: 'object', required: totals, properties: Object.fromEntries(totals.map((k) => [k, decimal])) },
            lines: {
              bsonType: 'array',
              items: {
                bsonType: 'object',
                required: ['lineId', 'itemId', 'qty', 'unitPrice', 'amounts', 'reservedQty', 'fulfilledQty', 'invoicedQty'],
                properties: {
                  qty: decimal,
                  unitPrice: decimal,
                  reservedQty: decimal,
                  fulfilledQty: decimal,
                  invoicedQty: decimal,
                  unitCost: decimalOrNull,
                  costValue: decimalOrNull,
                  amounts: { bsonType: 'object', required: amounts, properties: Object.fromEntries(amounts.map((k) => [k, decimal])) },
                },
              },
            },
          },
        },
      };
      for (const collection of ['quotations', 'salesOrders', 'dispatches', 'salesInvoices']) {
        await db.command({ collMod: collection, validator, validationLevel: 'strict', validationAction: 'error' });
      }
      await db.collection('legalEntities').updateMany({ logo: { $exists: false } }, { $set: { logo: null } });
    },
  },
  {
    id: '006-purchases',
    description: 'Create purchaseOrders, goodsReceipts and supplierBills collections with indexes and validators',
    async up({ connection, models }) {
      await ensureCollections(models);
      const db = connection.db;
      if (!db) throw new Error('Database connection is not open');
      const decimal = { bsonType: 'decimal' };
      const decimalOrNull = { bsonType: ['decimal', 'null'] };
      const totals = ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'reverseChargeTax', 'subtotal', 'roundOff', 'grand'];
      const amounts = ['gross', 'discount', 'net', 'documentDiscount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'total'];

      // Purchase Orders Validator
      await db.command({
        collMod: 'purchaseOrders',
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['tenantId', 'legalEntityId', 'supplierId', 'warehouseId', 'docType', 'status', 'docDate', 'lines', 'totals', 'documentDiscount', 'calcVersion'],
            properties: {
              docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              number: { bsonType: ['string', 'null'] },
              documentDiscount: decimal,
              totals: { bsonType: 'object', required: totals, properties: Object.fromEntries(totals.map((k) => [k, decimal])) },
              lines: {
                bsonType: 'array',
                items: {
                  bsonType: 'object',
                  required: ['lineId', 'itemId', 'qty', 'unitPrice', 'amounts', 'receivedQty', 'billedQty'],
                  properties: {
                    qty: decimal,
                    unitPrice: decimal,
                    receivedQty: decimal,
                    billedQty: decimal,
                    unitCost: decimalOrNull,
                    amounts: { bsonType: 'object', required: amounts, properties: Object.fromEntries(amounts.map((k) => [k, decimal])) },
                  },
                },
              },
            },
          },
        },
        validationLevel: 'strict',
        validationAction: 'error',
      });

      // Goods Receipts Validator
      await db.command({
        collMod: 'goodsReceipts',
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['tenantId', 'legalEntityId', 'supplierId', 'warehouseId', 'docType', 'status', 'docDate', 'lines'],
            properties: {
              docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              number: { bsonType: ['string', 'null'] },
              lines: {
                bsonType: 'array',
                items: {
                  bsonType: 'object',
                  required: ['lineId', 'itemId', 'qty', 'unitPrice', 'billedQty', 'billedValue', 'provisionalValue'],
                  properties: {
                    qty: decimal,
                    unitPrice: decimal,
                    billedQty: decimal,
                    billedValue: decimal,
                    provisionalValue: decimal,
                  },
                },
              },
            },
          },
        },
        validationLevel: 'strict',
        validationAction: 'error',
      });

      // Supplier Bills Validator
      await db.command({
        collMod: 'supplierBills',
        validator: {
          $jsonSchema: {
            bsonType: 'object',
            required: ['tenantId', 'legalEntityId', 'supplierId', 'supplierInvoiceNumber', 'supplierInvoiceDate', 'docType', 'status', 'paymentStatus', 'docDate', 'lines', 'totals', 'documentDiscount', 'outstanding', 'calcVersion'],
            properties: {
              docDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              supplierInvoiceDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
              number: { bsonType: ['string', 'null'] },
              documentDiscount: decimal,
              outstanding: decimal,
              supplierTotal: decimalOrNull,
              supplierRoundOff: decimalOrNull,
              totals: { bsonType: 'object', required: totals, properties: Object.fromEntries(totals.map((k) => [k, decimal])) },
              lines: {
                bsonType: 'array',
                items: {
                  bsonType: 'object',
                  required: ['lineId', 'itemId', 'qty', 'unitPrice', 'amounts'],
                  properties: {
                    qty: decimal,
                    unitPrice: decimal,
                    amounts: { bsonType: 'object', required: amounts, properties: Object.fromEntries(amounts.map((k) => [k, decimal])) },
                  },
                },
              },
            },
          },
        },
        validationLevel: 'strict',
        validationAction: 'error',
      });
    },
  },
  {
    id: '007-payments',
    description: 'Create collections and indexes for payments, allocations, refunds, expenses, and credit/debit notes',
    async up({ models }) {
      await ensureCollections(models);
    },
  },
];

interface MigrationRecord {
  _id: string;
  description: string;
  appliedAt: Date;
}

/** Applies pending migrations in order and records each in `_migrations`. Safe to re-run. */
export async function runMigrations(connection: Connection, models: Models, logger?: Logger): Promise<string[]> {
  const db = connection.db;
  if (!db) throw new Error('Database connection is not open');
  const records = db.collection<MigrationRecord>('_migrations');
  const applied = new Set((await records.find({}, { projection: { _id: 1 } }).toArray()).map((r) => r._id));
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    logger?.info({ migration: migration.id }, 'applying migration');
    await migration.up({ connection, models });
    await records.insertOne({ _id: migration.id, description: migration.description, appliedAt: new Date() });
    ran.push(migration.id);
  }
  return ran;
}
