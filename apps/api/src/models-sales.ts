import { Schema, type Types } from 'mongoose';
import type { SalesDocType, SalesDocumentKind } from '@bizmgmt/contracts';
import type { AddressDoc, BankAccountDoc } from './models-business.js';
import { tenantScoped } from './platform/tenant-scope.js';

/**
 * Sales documents (docs/database/schema.md "Documents"): quotations, sales
 * orders, dispatches and sales invoices share one shape, each in its own
 * collection. Money, prices, quantities and rates are Decimal128.
 *
 * Drafts hold the inputs and the figures last computed from them. Numbering a
 * document (send, confirm, dispatch, issue) recomputes the figures and freezes
 * them with the seller, buyer and item details; after that only the status and
 * fulfilment counters change.
 */
type Decimal = Types.Decimal128;

const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;

export interface AmountsDoc {
  gross: Decimal;
  discount: Decimal;
  net: Decimal;
  documentDiscount: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  utgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  taxCharged: Decimal;
  total: Decimal;
}

export interface TotalsDoc {
  gross: Decimal;
  discount: Decimal;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  utgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  taxCharged: Decimal;
  reverseChargeTax: Decimal;
  subtotal: Decimal;
  roundOff: Decimal;
  grand: Decimal;
}

export interface HsnRowDoc {
  hsnSac: string;
  rate: Decimal | null;
  reverseCharge: boolean;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  utgst: Decimal;
  igst: Decimal;
  cess: Decimal;
}

/** Item details as printed (frozen at numbering). */
export interface LineItemDoc {
  sku: string;
  name: string;
  type: 'stock' | 'non_stock' | 'service';
  hsnSac: string;
  unitCode: string;
  uqc: string;
  decimals: number;
}

export interface SalesLineDoc {
  lineId: string;
  itemId: Types.ObjectId;
  qty: Decimal;
  unitPrice: Decimal;
  discount: { type: 'percent' | 'amount'; value: Decimal } | null;
  /** The order line (on dispatches, and invoices from orders) or dispatch line (invoices from dispatches). */
  sourceLineId: string | null;
  item: LineItemDoc;
  taxRate: Decimal | null;
  cessRate: Decimal | null;
  reverseCharge: boolean;
  amounts: AmountsDoc;
  /** Orders: quantity held for this line now (FR-INV-05). */
  reservedQty: Decimal;
  /** Orders: dispatched or invoiced (by the stock-out point). */
  fulfilledQty: Decimal;
  /** Orders and dispatches: invoiced so far. */
  invoicedQty: Decimal;
  /** Where the line moved stock: the cost it left at (kept for reversal). */
  unitCost: Decimal | null;
  costValue: Decimal | null;
}

export interface SellerSnapshotDoc {
  legalEntityId: string;
  legalName: string;
  tradeName: string;
  pan: string;
  gstin: string;
  stateCode: string;
  registrationType: 'regular' | 'composition';
  address: AddressDoc;
  email: string;
  phone: string;
}

export interface BuyerSnapshotDoc {
  partyId: string;
  name: string;
  legalName: string;
  gstin: string | null;
  stateCode: string | null;
  billingAddress: AddressDoc | null;
  shippingAddress: AddressDoc | null;
}

export interface TransportDoc {
  vehicleNumber: string;
  transporterName: string;
  ewayBillNumber: string;
}

export interface SalesDocDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  gstRegistrationId: Types.ObjectId;
  docType: SalesDocType;
  /** The DOCUMENT_TYPES key that numbers it (tax invoices and bills of supply can switch while a draft). */
  documentKind: SalesDocumentKind;
  status: string;
  /** Chosen series (null = the default for the document kind). */
  seriesId: Types.ObjectId | null;
  /** Set with the number: the series, numbering scope and financial year used. */
  series: { seriesId: Types.ObjectId; scopeId: Types.ObjectId; fy: string; sequence: number } | null;
  number: string | null;
  docDate: string;
  partyId: Types.ObjectId;
  partyName: string;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  placeOfSupply: string;
  placeOfSupplyOverridden: boolean;
  supply: 'intra' | 'inter';
  warehouseId: Types.ObjectId | null;
  documentDiscount: Decimal;
  customerReference: string;
  notes: string;
  terms: string;
  validUntil: string | null;
  dueDate: string | null;
  expectedDate: string | null;
  transport: TransportDoc | null;
  lines: SalesLineDoc[];
  totals: TotalsDoc;
  hsnSummary: HsnRowDoc[];
  calcVersion: string;
  warnings: string[];
  seller: SellerSnapshotDoc;
  buyer: BuyerSnapshotDoc;
  /** Snapshots taken at numbering for the printed document. */
  logoFileId: Types.ObjectId | null;
  bankAccount: BankAccountDoc | null;
  templateVersion: string | null;
  source: { type: SalesDocType; id: Types.ObjectId } | null;
  revision: number;
  revisionOf: Types.ObjectId | null;
  /** Invoices: open amount (= grand total until receipts are allocated, Phase 9). */
  outstanding: Decimal | null;
  paymentStatus: 'unpaid' | 'partially_paid' | 'paid' | null;
  einvoiceStatus: 'not_applicable' | 'not_submitted' | null;
  createdBy: Types.ObjectId;
  issuedBy: Types.ObjectId | null;
  issuedAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const amountsFields = Object.fromEntries(['gross', 'discount', 'net', 'documentDiscount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'total'].map((k) => [k, { type: decimal, required: true }]));
const totalsFields = Object.fromEntries(['gross', 'discount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'reverseChargeTax', 'subtotal', 'roundOff', 'grand'].map((k) => [k, { type: decimal, required: true }]));

/** One schema instance per collection (Mongoose schemas carry per-model settings). */
export function salesDocumentSchema() {
  const lineSchema = new Schema<SalesLineDoc>(
    {
      lineId: { type: String, required: true },
      itemId: { type: objectId, required: true },
      qty: { type: decimal, required: true },
      unitPrice: { type: decimal, required: true },
      discount: { type: new Schema({ type: { type: String, enum: ['percent', 'amount'], required: true }, value: { type: decimal, required: true } }, { _id: false }), default: null },
      sourceLineId: { type: String, default: null },
      item: {
        type: new Schema<LineItemDoc>(
          { sku: String, name: String, type: { type: String, enum: ['stock', 'non_stock', 'service'] }, hsnSac: String, unitCode: String, uqc: String, decimals: Number },
          { _id: false },
        ),
        required: true,
      },
      taxRate: { type: decimal, default: null },
      cessRate: { type: decimal, default: null },
      reverseCharge: { type: Boolean, default: false },
      amounts: { type: new Schema(amountsFields, { _id: false }), required: true },
      reservedQty: { type: decimal, required: true },
      fulfilledQty: { type: decimal, required: true },
      invoicedQty: { type: decimal, required: true },
      unitCost: { type: decimal, default: null },
      costValue: { type: decimal, default: null },
    },
    { _id: false },
  );
  const schema = new Schema<SalesDocDoc>(
    {
      tenantId: { type: objectId, required: true },
      legalEntityId: { type: objectId, required: true },
      gstRegistrationId: { type: objectId, required: true },
      docType: { type: String, required: true },
      documentKind: { type: String, required: true },
      status: { type: String, required: true },
      seriesId: { type: objectId, default: null },
      series: { type: new Schema({ seriesId: objectId, scopeId: objectId, fy: String, sequence: Number }, { _id: false }), default: null },
      number: { type: String, default: null },
      docDate: { type: String, required: true },
      partyId: { type: objectId, required: true },
      partyName: { type: String, required: true },
      billingAddressId: { type: String, default: null },
      shippingAddressId: { type: String, default: null },
      placeOfSupply: { type: String, required: true },
      placeOfSupplyOverridden: { type: Boolean, default: false },
      supply: { type: String, enum: ['intra', 'inter'], required: true },
      warehouseId: { type: objectId, default: null },
      documentDiscount: { type: decimal, required: true },
      customerReference: { type: String, default: '' },
      notes: { type: String, default: '' },
      terms: { type: String, default: '' },
      validUntil: { type: String, default: null },
      dueDate: { type: String, default: null },
      expectedDate: { type: String, default: null },
      transport: { type: new Schema<TransportDoc>({ vehicleNumber: String, transporterName: String, ewayBillNumber: String }, { _id: false }), default: null },
      lines: { type: [lineSchema], default: [] },
      totals: { type: new Schema(totalsFields, { _id: false }), required: true },
      hsnSummary: {
        type: [
          new Schema<HsnRowDoc>(
            {
              hsnSac: String,
              rate: { type: decimal, default: null },
              reverseCharge: Boolean,
              ...Object.fromEntries(['taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess'].map((k) => [k, { type: decimal, required: true }])),
            },
            { _id: false },
          ),
        ],
        default: [],
      },
      calcVersion: { type: String, required: true },
      warnings: { type: [String], default: [] },
      // Plain text only (names, identifiers, addresses); no money.
      seller: { type: Schema.Types.Mixed, required: true },
      buyer: { type: Schema.Types.Mixed, required: true },
      logoFileId: { type: objectId, default: null },
      bankAccount: { type: Schema.Types.Mixed, default: null },
      templateVersion: { type: String, default: null },
      source: { type: new Schema({ type: { type: String, required: true }, id: { type: objectId, required: true } }, { _id: false }), default: null },
      revision: { type: Number, default: 0 },
      revisionOf: { type: objectId, default: null },
      outstanding: { type: decimal, default: null },
      paymentStatus: { type: String, default: null },
      einvoiceStatus: { type: String, default: null },
      createdBy: { type: objectId, required: true },
      issuedBy: { type: objectId, default: null },
      issuedAt: { type: Date, default: null },
      cancelledBy: { type: objectId, default: null },
      cancelledAt: { type: Date, default: null },
      cancelReason: { type: String, default: null },
      version: { type: Number, default: 0 },
    },
    { timestamps: true },
  );
  // Final guard on numbering (architecture §8): one number per series scope, document kind and financial year.
  schema.index({ tenantId: 1, 'series.scopeId': 1, documentKind: 1, 'series.fy': 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
  schema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
  schema.index({ tenantId: 1, partyId: 1, _id: -1 });
  schema.index({ tenantId: 1, status: 1, _id: -1 });
  schema.index({ tenantId: 1, 'source.id': 1 });
  schema.index({ tenantId: 1, revisionOf: 1 });
  schema.plugin(tenantScoped);
  return schema;
}

export const quotationSchema = salesDocumentSchema();
export const salesOrderSchema = salesDocumentSchema();
// Reconciliation sums reservations of open orders per warehouse.
salesOrderSchema.index({ tenantId: 1, status: 1, warehouseId: 1 });
export const dispatchSchema = salesDocumentSchema();
export const salesInvoiceSchema = salesDocumentSchema();
// Receivables: open invoices by entity and due date; credit exposure by customer.
salesInvoiceSchema.index({ tenantId: 1, legalEntityId: 1, status: 1, dueDate: 1 });
salesInvoiceSchema.index({ tenantId: 1, partyId: 1, status: 1 });
