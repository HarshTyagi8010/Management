import { Schema, type Types } from 'mongoose';
import type { PurchaseDocType } from '@bizmgmt/contracts';
import type { AmountsDoc, BuyerSnapshotDoc, HsnRowDoc, LineItemDoc, SellerSnapshotDoc, TotalsDoc } from './models-sales.js';
import { tenantScoped } from './platform/tenant-scope.js';

type Decimal = Types.Decimal128;

const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;

export interface PurchaseLineDoc {
  lineId: string;
  itemId: Types.ObjectId;
  description: string;
  qty: Decimal;
  unitPrice: Decimal;
  discount: { type: 'percent' | 'amount'; value: Decimal } | null;
  sourceLineId: string | null;
  item: LineItemDoc;
  taxRate: Decimal | null;
  cessRate: Decimal | null;
  reverseCharge: boolean;
  amounts: AmountsDoc;
  receivedQty: Decimal;
  billedQty: Decimal;
  unitCost: Decimal | null;
}

export interface PurchaseOrderDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  supplierId: Types.ObjectId;
  supplierName: string;
  warehouseId: Types.ObjectId;
  docType: 'purchase_order';
  status: string;
  seriesId: Types.ObjectId | null;
  series: { seriesId: Types.ObjectId; scopeId: Types.ObjectId; fy: string; sequence: number } | null;
  number: string | null;
  docDate: string;
  expectedDeliveryDate: string | null;
  documentDiscount: Decimal;
  notes: string;
  terms: string;
  lines: PurchaseLineDoc[];
  totals: TotalsDoc;
  hsnSummary: HsnRowDoc[];
  calcVersion: string;
  supplier: BuyerSnapshotDoc;
  buyer: SellerSnapshotDoc;
  pdfReady: boolean;
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

export interface GoodsReceiptLineDoc {
  lineId: string;
  sourceLineId: string | null;
  itemId: Types.ObjectId;
  description: string;
  qty: Decimal;
  unitPrice: Decimal;
  item: LineItemDoc;
  billedQty: Decimal;
  billedValue: Decimal;
  provisionalValue: Decimal;
}

export interface GoodsReceiptDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  supplierId: Types.ObjectId;
  supplierName: string;
  warehouseId: Types.ObjectId;
  purchaseOrderId: Types.ObjectId | null;
  supplierDeliveryChallanNumber: string | null;
  docType: 'goods_receipt';
  status: string;
  number: string | null;
  docDate: string;
  notes: string;
  lines: GoodsReceiptLineDoc[];
  supplier: BuyerSnapshotDoc;
  createdBy: Types.ObjectId;
  receivedBy: Types.ObjectId | null;
  receivedAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface SupplierBillLineDoc {
  lineId: string;
  sourceLineId: string | null;
  goodsReceiptLineId: string | null;
  itemId: Types.ObjectId;
  description: string;
  qty: Decimal;
  unitPrice: Decimal;
  discount: { type: 'percent' | 'amount'; value: Decimal } | null;
  item: LineItemDoc;
  taxRate: Decimal | null;
  cessRate: Decimal | null;
  reverseCharge: boolean;
  amounts: AmountsDoc;
}

export interface SupplierBillDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  supplierId: Types.ObjectId;
  supplierName: string;
  warehouseId: Types.ObjectId | null;
  purchaseOrderId: Types.ObjectId | null;
  goodsReceiptId: Types.ObjectId | null;
  supplierInvoiceNumber: string;
  supplierInvoiceDate: string;
  docType: 'supplier_bill';
  status: string;
  paymentStatus: string;
  number: string | null;
  docDate: string;
  dueDate: string | null;
  itcEligible: boolean;
  supplierTotal: Decimal | null;
  supplierRoundOff: Decimal | null;
  documentDiscount: Decimal;
  notes: string;
  lines: SupplierBillLineDoc[];
  totals: TotalsDoc;
  hsnSummary: HsnRowDoc[];
  calcVersion: string;
  supplier: BuyerSnapshotDoc;
  buyer: SellerSnapshotDoc;
  outstanding: Decimal;
  createdBy: Types.ObjectId;
  postedBy: Types.ObjectId | null;
  postedAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const amountsFields = Object.fromEntries(
  ['gross', 'discount', 'net', 'documentDiscount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'total'].map(
    (k) => [k, { type: decimal, required: true }],
  ),
);

const totalsFields = Object.fromEntries(
  ['gross', 'discount', 'taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess', 'taxCharged', 'reverseChargeTax', 'subtotal', 'roundOff', 'grand'].map(
    (k) => [k, { type: decimal, required: true }],
  ),
);

const lineItemSchema = new Schema<LineItemDoc>(
  { sku: String, name: String, type: { type: String, enum: ['stock', 'non_stock', 'service'] }, hsnSac: String, unitCode: String, uqc: String, decimals: Number },
  { _id: false },
);

const hsnRowSchema = new Schema<HsnRowDoc>(
  {
    hsnSac: String,
    rate: { type: decimal, default: null },
    reverseCharge: Boolean,
    ...Object.fromEntries(['taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess'].map((k) => [k, { type: decimal, required: true }])),
  },
  { _id: false },
);

// Purchase Order Schema
export const purchaseOrderSchema: Schema<PurchaseOrderDoc> = new Schema<PurchaseOrderDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    supplierId: { type: objectId, required: true },
    supplierName: { type: String, required: true },
    warehouseId: { type: objectId, required: true },
    docType: { type: String, default: 'purchase_order', required: true },
    status: { type: String, required: true },
    seriesId: { type: objectId, default: null },
    series: { type: new Schema({ seriesId: objectId, scopeId: objectId, fy: String, sequence: Number }, { _id: false }), default: null },
    number: { type: String, default: null },
    docDate: { type: String, required: true },
    expectedDeliveryDate: { type: String, default: null },
    documentDiscount: { type: decimal, required: true },
    notes: { type: String, default: '' },
    terms: { type: String, default: '' },
    lines: {
      type: [
        new Schema<PurchaseLineDoc>(
          {
            lineId: { type: String, required: true },
            itemId: { type: objectId, required: true },
            description: { type: String, default: '' },
            qty: { type: decimal, required: true },
            unitPrice: { type: decimal, required: true },
            discount: { type: new Schema({ type: { type: String, enum: ['percent', 'amount'] }, value: decimal }, { _id: false }), default: null },
            sourceLineId: { type: String, default: null },
            item: { type: lineItemSchema, required: true },
            taxRate: { type: decimal, default: null },
            cessRate: { type: decimal, default: null },
            reverseCharge: { type: Boolean, default: false },
            amounts: { type: new Schema(amountsFields, { _id: false }), required: true },
            receivedQty: { type: decimal, required: true },
            billedQty: { type: decimal, required: true },
            unitCost: { type: decimal, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    totals: { type: new Schema(totalsFields, { _id: false }), required: true },
    hsnSummary: { type: [hsnRowSchema], default: [] },
    calcVersion: { type: String, required: true },
    supplier: { type: Schema.Types.Mixed, required: true } as any,
    buyer: { type: Schema.Types.Mixed, required: true } as any,
    pdfReady: { type: Boolean, default: false },
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

purchaseOrderSchema.index(
  { tenantId: 1, 'series.scopeId': 1, 'series.fy': 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: 'string' } } },
);
purchaseOrderSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
purchaseOrderSchema.index({ tenantId: 1, supplierId: 1, _id: -1 });
purchaseOrderSchema.index({ tenantId: 1, status: 1, _id: -1 });
purchaseOrderSchema.plugin(tenantScoped);

// Goods Receipt Schema
export const goodsReceiptSchema: Schema<GoodsReceiptDoc> = new Schema<GoodsReceiptDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    supplierId: { type: objectId, required: true },
    supplierName: { type: String, required: true },
    warehouseId: { type: objectId, required: true },
    purchaseOrderId: { type: objectId, default: null },
    supplierDeliveryChallanNumber: { type: String, default: null },
    docType: { type: String, default: 'goods_receipt', required: true },
    status: { type: String, required: true },
    number: { type: String, default: null },
    docDate: { type: String, required: true },
    notes: { type: String, default: '' },
    lines: {
      type: [
        new Schema<GoodsReceiptLineDoc>(
          {
            lineId: { type: String, required: true },
            sourceLineId: { type: String, default: null },
            itemId: { type: objectId, required: true },
            description: { type: String, default: '' },
            qty: { type: decimal, required: true },
            unitPrice: { type: decimal, required: true },
            item: { type: lineItemSchema, required: true },
            billedQty: { type: decimal, required: true },
            billedValue: { type: decimal, required: true },
            provisionalValue: { type: decimal, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    supplier: { type: Schema.Types.Mixed, required: true },
    createdBy: { type: objectId, required: true },
    receivedBy: { type: objectId, default: null },
    receivedAt: { type: Date, default: null },
    cancelledBy: { type: objectId, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

goodsReceiptSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
goodsReceiptSchema.index({ tenantId: 1, supplierId: 1, _id: -1 });
goodsReceiptSchema.index({ tenantId: 1, purchaseOrderId: 1, _id: -1 });
goodsReceiptSchema.index({ tenantId: 1, status: 1, _id: -1 });
goodsReceiptSchema.plugin(tenantScoped);

// Supplier Bill Schema
export const supplierBillSchema: Schema<SupplierBillDoc> = new Schema<SupplierBillDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    supplierId: { type: objectId, required: true },
    supplierName: { type: String, required: true },
    warehouseId: { type: objectId, default: null },
    purchaseOrderId: { type: objectId, default: null },
    goodsReceiptId: { type: objectId, default: null },
    supplierInvoiceNumber: { type: String, required: true },
    supplierInvoiceDate: { type: String, required: true },
    docType: { type: String, default: 'supplier_bill', required: true },
    status: { type: String, required: true },
    paymentStatus: { type: String, default: 'unpaid', required: true },
    number: { type: String, default: null },
    docDate: { type: String, required: true },
    dueDate: { type: String, default: null },
    itcEligible: { type: Boolean, default: true },
    supplierTotal: { type: decimal, default: null },
    supplierRoundOff: { type: decimal, default: null },
    documentDiscount: { type: decimal, required: true },
    notes: { type: String, default: '' },
    lines: {
      type: [
        new Schema<SupplierBillLineDoc>(
          {
            lineId: { type: String, required: true },
            sourceLineId: { type: String, default: null },
            goodsReceiptLineId: { type: String, default: null },
            itemId: { type: objectId, required: true },
            description: { type: String, default: '' },
            qty: { type: decimal, required: true },
            unitPrice: { type: decimal, required: true },
            discount: { type: new Schema({ type: { type: String, enum: ['percent', 'amount'] }, value: decimal }, { _id: false }), default: null },
            item: { type: lineItemSchema, required: true },
            taxRate: { type: decimal, default: null },
            cessRate: { type: decimal, default: null },
            reverseCharge: { type: Boolean, default: false },
            amounts: { type: new Schema(amountsFields, { _id: false }), required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    totals: { type: new Schema(totalsFields, { _id: false }), required: true },
    hsnSummary: { type: [hsnRowSchema], default: [] },
    calcVersion: { type: String, required: true },
    supplier: { type: Schema.Types.Mixed, required: true } as any,
    buyer: { type: Schema.Types.Mixed, required: true } as any,
    outstanding: { type: decimal, required: true },
    createdBy: { type: objectId, required: true },
    postedBy: { type: objectId, default: null },
    postedAt: { type: Date, default: null },
    cancelledBy: { type: objectId, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Duplicate supplier invoice check: supplierInvoiceNumber unique per supplier and tenant
supplierBillSchema.index(
  { tenantId: 1, supplierId: 1, supplierInvoiceNumber: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['draft', 'posted'] } } },
);
supplierBillSchema.index({ tenantId: 1, legalEntityId: 1, status: 1, dueDate: 1 });
supplierBillSchema.index({ tenantId: 1, supplierId: 1, status: 1 });
supplierBillSchema.index({ tenantId: 1, purchaseOrderId: 1 });
supplierBillSchema.index({ tenantId: 1, goodsReceiptId: 1 });
supplierBillSchema.plugin(tenantScoped);
