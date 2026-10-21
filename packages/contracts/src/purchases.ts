import { z } from 'zod';
import {
  businessDateSchema,
  idempotencyKeySchema,
  moneySchema,
  nonNegativeMoneySchema,
  objectIdSchema,
  quantitySchema,
  unitPriceSchema,
} from './primitives.js';

const objectIdString = objectIdSchema;
const dateString = businessDateSchema;
const amountString = moneySchema;
const nonNegativeAmountString = nonNegativeMoneySchema;
const quantityString = quantitySchema;
const decimalString = unitPriceSchema;
const idempotencyKeyString = idempotencyKeySchema;

const positiveQuantity = quantityString.refine((v: string) => !v.startsWith('-') && /[1-9]/.test(v), 'Enter a quantity more than zero');

export const PURCHASE_DOC_TYPES = ['purchase_order', 'goods_receipt', 'supplier_bill'] as const;
export type PurchaseDocType = (typeof PURCHASE_DOC_TYPES)[number];

export const PURCHASE_ORDER_STATUSES = ['draft', 'issued', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const GOODS_RECEIPT_STATUSES = ['draft', 'received', 'partially_billed', 'billed', 'cancelled'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

export const SUPPLIER_BILL_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type SupplierBillStatus = (typeof SUPPLIER_BILL_STATUSES)[number];

export type PurchaseDocStatus = PurchaseOrderStatus | GoodsReceiptStatus | SupplierBillStatus;

export const PURCHASE_PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'] as const;
export type PurchasePaymentStatus = (typeof PURCHASE_PAYMENT_STATUSES)[number];

export const purchaseLineInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  itemId: objectIdString,
  description: z.string().trim().max(300).default(''),
  qty: positiveQuantity,
  unitPrice: decimalString,
  discountPercent: decimalString.optional(),
  discountAmount: amountString.optional(),
  taxClassId: objectIdString.optional(),
  notes: z.string().trim().max(500).optional(),
  sourceLineId: z.string().trim().min(1).nullable().optional(),
});
export type PurchaseLineInput = z.infer<typeof purchaseLineInputSchema>;

export const purchaseDocAmountsSchema = z.object({
  gross: amountString,
  discount: amountString,
  taxable: amountString,
  cgst: amountString,
  sgst: amountString,
  utgst: amountString,
  igst: amountString,
  cess: amountString,
  taxCharged: amountString,
  reverseChargeTax: amountString,
  subtotal: amountString,
  roundOff: amountString,
  grand: amountString,
});
export type PurchaseDocAmounts = z.infer<typeof purchaseDocAmountsSchema>;
export type PurchaseTotals = PurchaseDocAmounts;

export const purchaseLineResponseSchema = z.object({
  id: z.string().trim().min(1),
  itemId: objectIdString,
  itemSku: z.string(),
  itemName: z.string(),
  itemType: z.enum(['goods', 'service']),
  hsnSac: z.string(),
  unitCode: z.string(),
  unitName: z.string(),
  uqc: z.string(),
  description: z.string(),
  qty: quantityString,
  unitPrice: decimalString.optional(),
  discountPercent: decimalString.optional(),
  discountAmount: amountString.optional(),
  taxClassId: objectIdString.nullable().optional(),
  taxRatePercent: decimalString.nullable().optional(),
  taxableAmount: amountString.optional(),
  cgst: amountString.optional(),
  sgst: amountString.optional(),
  utgst: amountString.optional(),
  igst: amountString.optional(),
  cess: amountString.optional(),
  lineTotal: amountString.optional(),
  receivedQty: quantityString.optional(),
  billedQty: quantityString.optional(),
  sourceLineId: z.string().trim().min(1).nullable().optional(),
});
export type PurchaseLineResponse = z.infer<typeof purchaseLineResponseSchema>;

export const purchasePartySnapshotSchema = z.object({
  partyId: objectIdString,
  name: z.string(),
  legalName: z.string(),
  pan: z.string(),
  gstin: z.string().nullable().optional(),
  address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    district: z.string().optional(),
    stateCode: z.string(),
    pincode: z.string(),
  }),
});
export type PurchasePartySnapshot = z.infer<typeof purchasePartySnapshotSchema>;

// Purchase Order Schemas
export const createPurchaseOrderSchema = z.object({
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  warehouseId: objectIdString,
  docDate: dateString,
  expectedDeliveryDate: dateString.optional(),
  seriesId: objectIdString.optional(),
  documentDiscount: amountString.optional(),
  notes: z.string().trim().max(1000).optional(),
  terms: z.string().trim().max(2000).optional(),
  lines: z.array(purchaseLineInputSchema).min(1, 'At least one line is required'),
});
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export const updatePurchaseOrderSchema = createPurchaseOrderSchema.partial();
export type UpdatePurchaseOrderInput = z.infer<typeof updatePurchaseOrderSchema>;

export const purchaseOrderResponseSchema = z.object({
  id: objectIdString,
  docType: z.literal('purchase_order'),
  status: z.enum(PURCHASE_ORDER_STATUSES),
  number: z.string().nullable(),
  issuedAt: z.string().nullable().optional(),
  docDate: dateString,
  expectedDeliveryDate: dateString.nullable().optional(),
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  warehouseId: objectIdString,
  warehouseName: z.string().optional(),
  supplier: purchasePartySnapshotSchema.nullable(),
  lines: z.array(purchaseLineResponseSchema),
  amounts: purchaseDocAmountsSchema.optional(),
  notes: z.string().nullable(),
  terms: z.string().nullable(),
  pdfReady: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseOrderResponse = z.infer<typeof purchaseOrderResponseSchema>;

// Goods Receipt Schemas
export const goodsReceiptLineInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  sourceLineId: z.string().trim().min(1).nullable().optional(),
  itemId: objectIdString,
  qty: positiveQuantity,
  unitPrice: decimalString.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const createGoodsReceiptSchema = z.object({
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  warehouseId: objectIdString,
  purchaseOrderId: objectIdString.optional(),
  supplierDeliveryChallanNumber: z.string().trim().max(50).optional(),
  docDate: dateString,
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(goodsReceiptLineInputSchema).min(1, 'At least one line is required'),
});
export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;
export const updateGoodsReceiptSchema = createGoodsReceiptSchema.partial();
export type UpdateGoodsReceiptInput = z.infer<typeof updateGoodsReceiptSchema>;

export const goodsReceiptResponseSchema = z.object({
  id: objectIdString,
  docType: z.literal('goods_receipt'),
  status: z.enum(GOODS_RECEIPT_STATUSES),
  number: z.string().nullable(),
  docDate: dateString,
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  warehouseId: objectIdString,
  warehouseName: z.string().optional(),
  purchaseOrderId: objectIdString.nullable().optional(),
  supplierDeliveryChallanNumber: z.string().nullable().optional(),
  supplier: purchasePartySnapshotSchema.nullable(),
  lines: z.array(purchaseLineResponseSchema),
  notes: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GoodsReceiptResponse = z.infer<typeof goodsReceiptResponseSchema>;

// Supplier Bill Schemas
export const supplierBillLineInputSchema = z.object({
  id: z.string().trim().min(1).optional(),
  sourceLineId: z.string().trim().min(1).nullable().optional(),
  goodsReceiptLineId: z.string().trim().min(1).nullable().optional(),
  itemId: objectIdString,
  description: z.string().trim().max(300).default(''),
  qty: positiveQuantity,
  unitPrice: decimalString,
  discountPercent: decimalString.optional(),
  discountAmount: amountString.optional(),
  taxClassId: objectIdString.optional(),
  notes: z.string().trim().max(500).optional(),
});

export const createSupplierBillSchema = z.object({
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  supplierInvoiceNumber: z.string().trim().min(1).max(50),
  supplierInvoiceDate: dateString,
  docDate: dateString,
  dueDate: dateString.optional(),
  purchaseOrderId: objectIdString.optional(),
  goodsReceiptId: objectIdString.optional(),
  warehouseId: objectIdString.optional(),
  itcEligible: z.boolean().default(true),
  supplierTotal: amountString.optional(),
  documentDiscount: amountString.optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(supplierBillLineInputSchema).min(1, 'At least one line is required'),
});
export type CreateSupplierBillInput = z.infer<typeof createSupplierBillSchema>;
export const updateSupplierBillSchema = createSupplierBillSchema.partial();
export type UpdateSupplierBillInput = z.infer<typeof updateSupplierBillSchema>;

export const supplierBillResponseSchema = z.object({
  id: objectIdString,
  docType: z.literal('supplier_bill'),
  status: z.enum(SUPPLIER_BILL_STATUSES),
  paymentStatus: z.enum(PURCHASE_PAYMENT_STATUSES),
  number: z.string().nullable(),
  supplierInvoiceNumber: z.string(),
  supplierInvoiceDate: dateString,
  docDate: dateString,
  dueDate: dateString.nullable().optional(),
  legalEntityId: objectIdString,
  supplierId: objectIdString,
  warehouseId: objectIdString.nullable().optional(),
  purchaseOrderId: objectIdString.nullable().optional(),
  goodsReceiptId: objectIdString.nullable().optional(),
  itcEligible: z.boolean(),
  supplier: purchasePartySnapshotSchema.nullable(),
  lines: z.array(purchaseLineResponseSchema),
  amounts: purchaseDocAmountsSchema,
  outstanding: amountString,
  notes: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupplierBillResponse = z.infer<typeof supplierBillResponseSchema>;

// Commands
export const issuePurchaseOrderCommandSchema = z.object({
  seriesId: objectIdString.optional(),
});

export const receiveGoodsReceiptCommandSchema = z.object({
  idempotencyKey: idempotencyKeyString.optional(),
});

export const postSupplierBillCommandSchema = z.object({
  idempotencyKey: idempotencyKeyString.optional(),
});
export type PostSupplierBillCommand = z.infer<typeof postSupplierBillCommandSchema>;

export const cancelPurchaseDocCommandSchema = z.object({
  version: z.number().int().min(1).optional(),
  reason: z.string().trim().min(3).max(500),
});

export const purchaseDocCommandSchema = z.object({
  version: z.number().int().min(1).optional(),
});

export const purchaseDocListQuerySchema = z.object({
  legalEntityId: objectIdString.optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
  supplierId: objectIdString.optional(),
  warehouseId: objectIdString.optional(),
  purchaseOrderId: objectIdString.optional(),
  goodsReceiptId: objectIdString.optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdString.optional(),
});
export type PurchaseDocListQuery = z.infer<typeof purchaseDocListQuerySchema>;

export const payablesQuerySchema = z.object({
  legalEntityId: objectIdString.optional(),
  supplierId: objectIdString.optional(),
  asOf: dateString.optional(),
});
export type PayablesQuery = z.infer<typeof payablesQuerySchema>;

// Payables & Ageing Schemas
export const payableItemSchema = z.object({
  id: objectIdString,
  billNumber: z.string(),
  supplierInvoiceNumber: z.string(),
  supplierInvoiceDate: dateString,
  docDate: dateString,
  dueDate: dateString,
  supplierId: objectIdString,
  supplierName: z.string(),
  grandTotal: amountString,
  outstanding: amountString,
  daysOverdue: z.number().int(),
  ageingBucket: z.enum(['not_due', 'd1_30', 'd31_60', 'd61_90', 'over_90', '1_30', '31_60', '61_90']),
});
export type PayableItem = z.infer<typeof payableItemSchema>;

export const payablesSummarySchema = z.object({
  totalOutstanding: amountString,
  notDue: amountString,
  bucket1_30: amountString,
  bucket31_60: amountString,
  bucket61_90: amountString,
  bucketOver90: amountString,
  bills: z.array(payableItemSchema),
});
export type PayablesSummary = z.infer<typeof payablesSummarySchema>;

export const PURCHASE_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  issued: 'Issued',
  partially_received: 'Partially received',
  received: 'Received',
  partially_billed: 'Partially billed',
  billed: 'Billed',
  posted: 'Posted',
  closed: 'Closed',
  cancelled: 'Cancelled',
  discarded: 'Discarded',
};

export const purchaseOrderSchema = purchaseOrderResponseSchema;
export type PurchaseOrder = PurchaseOrderResponse;
export type PurchaseOrderLine = PurchaseOrderResponse['lines'][number];

export const goodsReceiptSchema = goodsReceiptResponseSchema;
export type GoodsReceipt = GoodsReceiptResponse;
export type GoodsReceiptLine = GoodsReceiptResponse['lines'][number];

export const supplierBillSchema = supplierBillResponseSchema;
export type SupplierBill = SupplierBillResponse;
export type SupplierBillLine = SupplierBillResponse['lines'][number];

export const payablesSchema = payablesSummarySchema;
export type Payables = PayablesSummary;

