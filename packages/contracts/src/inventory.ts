import { z } from 'zod';
import { nonNegativeQuantitySchema } from './catalogue.js';
import { documentArtifactSchema } from './finance.js';
import { addressSchema } from './organization.js';
import { patchShape } from './patch.js';
import { businessDateSchema, objectIdSchema, quantitySchema, unitPriceSchema } from './primitives.js';

/**
 * Inventory (FR-INV-01..10): warehouses, append-only stock movements, opening
 * stock, adjustments, transfers, counts and the reconciliation report.
 * Quantities are in the item's base unit. Cost and value fields are omitted for
 * callers without price.view_cost (FR-RBAC-04).
 */

const version = z.number().int().min(0);
const versionOnly = z.strictObject({ version });
export const stockCommandSchema = versionOnly;

const positiveQuantitySchema = quantitySchema.refine((v) => !v.startsWith('-') && /[1-9]/.test(v), 'Enter a quantity more than zero');
const nonZeroQuantitySchema = quantitySchema.refine((v) => /[1-9]/.test(v), 'A quantity of zero changes nothing');

// ------------------------------------------------------------ warehouses

export const warehouseCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, 'Use up to 12 letters, digits or hyphens'));

export const warehouseInputSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  code: warehouseCodeSchema,
  name: z.string().trim().min(1).max(80),
  address: addressSchema.nullable().default(null),
  /** The GST registration (place of business) this warehouse belongs to, if any. */
  gstRegistrationId: objectIdSchema.nullable().default(null),
});

export const warehouseUpdateSchema = z.strictObject({
  ...patchShape(warehouseInputSchema.omit({ legalEntityId: true, code: true }).shape),
  version,
  archived: z.boolean().optional(),
});

export const warehouseSchema = z.strictObject({
  id: objectIdSchema,
  legalEntityId: objectIdSchema,
  code: z.string(),
  name: z.string(),
  address: addressSchema.nullable(),
  gstRegistrationId: objectIdSchema.nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type Warehouse = z.infer<typeof warehouseSchema>;

// ------------------------------------------------------------- movements

/** Every kind a movement can have; Phase 5 writes opening, transfer, adjust and revalue movements. */
export const MOVEMENT_KINDS = ['opening', 'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjust', 'return_in', 'return_out', 'revalue'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const MOVEMENT_KIND_LABELS: Record<MovementKind, string> = {
  opening: 'Opening stock',
  receipt: 'Received',
  issue: 'Issued',
  transfer_out: 'Transfer out',
  transfer_in: 'Transfer in',
  adjust: 'Adjustment',
  return_in: 'Return in',
  return_out: 'Return out',
  revalue: 'Revaluation',
};

export const STOCK_SOURCE_TYPES = [
  'stock_adjustment',
  'stock_transfer',
  'stock_count',
  'dispatch',
  'sales_invoice',
  'goods_receipt',
  'supplier_bill',
  'sales_return',
  'purchase_return',
] as const;
export type StockSourceType = (typeof STOCK_SOURCE_TYPES)[number];

export const stockMovementSchema = z.strictObject({
  id: objectIdSchema,
  at: z.iso.datetime(),
  docDate: z.string(),
  kind: z.enum(MOVEMENT_KINDS),
  warehouseId: objectIdSchema,
  warehouseCode: z.string(),
  itemId: objectIdSchema,
  sku: z.string(),
  itemName: z.string(),
  unitCode: z.string(),
  /** Signed: positive in, negative out. */
  qty: z.string(),
  /** On hand in this warehouse right after the movement. */
  onHandAfter: z.string(),
  unitCost: z.string().optional(),
  value: z.string().optional(),
  source: z.strictObject({ type: z.enum(STOCK_SOURCE_TYPES), id: objectIdSchema, number: z.string() }),
  /** True for a movement that reverses an earlier one (e.g. a cancelled transfer). */
  reversal: z.boolean(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const movementListQuerySchema = z.strictObject({
  legalEntityId: objectIdSchema,
  warehouseId: objectIdSchema.optional(),
  itemId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdSchema.optional(),
});

// --------------------------------------------------------------- balances

export const stockSummaryQuerySchema = z.strictObject({
  legalEntityId: objectIdSchema,
  warehouseId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

export const stockSummaryRowSchema = z.strictObject({
  itemId: objectIdSchema,
  sku: z.string(),
  name: z.string(),
  unitCode: z.string(),
  reorderLevel: z.string().nullable(),
  onHand: z.string(),
  /** Held for confirmed sales orders; never reduces on hand. */
  reserved: z.string(),
  available: z.string(),
  /** Dispatched from another warehouse towards this one, not yet received. */
  inTransit: z.string(),
  belowReorder: z.boolean(),
  avgCost: z.string().nullable().optional(),
  /** On hand × average cost. */
  value: z.string().optional(),
});
export type StockSummaryRow = z.infer<typeof stockSummaryRowSchema>;

export const stockValuationSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  asOf: z.iso.datetime(),
  totalValue: z.string(),
  rows: z.array(
    z.strictObject({
      itemId: objectIdSchema,
      sku: z.string(),
      name: z.string(),
      unitCode: z.string(),
      /** All warehouses of the entity plus goods in transit between them. */
      qty: z.string(),
      avgCost: z.string().nullable(),
      value: z.string(),
    }),
  ),
});
export type StockValuation = z.infer<typeof stockValuationSchema>;

// ------------------------------------------------- adjustments and opening

export const ADJUSTMENT_REASONS = ['damage', 'loss', 'theft', 'expiry', 'found', 'sample', 'correction', 'other'] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const ADJUSTMENT_REASON_LABELS: Record<AdjustmentReason, string> = {
  damage: 'Damaged',
  loss: 'Lost or missing',
  theft: 'Theft',
  expiry: 'Expired',
  found: 'Found',
  sample: 'Free sample or own use',
  correction: 'Correction of an earlier entry',
  other: 'Other',
};

export const STOCK_DOC_STATUSES = ['draft', 'posted', 'cancelled'] as const;

const adjustmentLineInputSchema = z.strictObject({
  itemId: objectIdSchema,
  /** Signed for adjustments (negative = out); more than zero for opening stock. */
  qty: nonZeroQuantitySchema,
  /** Opening stock: required. Adjustments in: optional, defaults to the current average cost. Ignored for stock out. */
  unitCost: unitPriceSchema.nullable().default(null),
});

const adjustmentFields = {
  warehouseId: objectIdSchema,
  type: z.enum(['opening', 'adjustment']),
  /** Required for adjustments (FR-INV-07); not used for opening stock. */
  reason: z.enum(ADJUSTMENT_REASONS).nullable().default(null),
  note: z.string().trim().max(500).default(''),
  docDate: businessDateSchema,
  lines: z
    .array(adjustmentLineInputSchema)
    .min(1, 'Add at least one item')
    .max(200)
    .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, 'Each item only once'),
};

function adjustmentRules<T extends { type?: 'opening' | 'adjustment' | undefined; reason?: AdjustmentReason | null | undefined; lines?: Array<{ qty: string; unitCost: string | null }> | undefined }>(v: T, ctx: z.RefinementCtx) {
  if (v.type === 'adjustment' && !v.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Choose a reason' });
  if (v.type === 'opening') {
    v.lines?.forEach((l, i) => {
      if (l.qty.startsWith('-')) ctx.addIssue({ code: 'custom', path: ['lines', i, 'qty'], message: 'Opening stock is more than zero' });
      if (l.unitCost === null) ctx.addIssue({ code: 'custom', path: ['lines', i, 'unitCost'], message: 'Enter the cost of the opening stock' });
    });
  }
}

export const stockAdjustmentInputSchema = z.strictObject(adjustmentFields).superRefine(adjustmentRules);
export const stockAdjustmentUpdateSchema = z.strictObject({ ...patchShape(z.strictObject(adjustmentFields).omit({ warehouseId: true, type: true }).shape), version });

const stockDocLineBase = {
  lineId: z.string(),
  itemId: objectIdSchema,
  sku: z.string(),
  itemName: z.string(),
  unitCode: z.string(),
};

const actorSchema = z.strictObject({ id: objectIdSchema, name: z.string() }).nullable();

export const stockAdjustmentSchema = z.strictObject({
  id: objectIdSchema,
  number: z.string(),
  type: z.enum(['opening', 'adjustment']),
  status: z.enum(STOCK_DOC_STATUSES),
  legalEntityId: objectIdSchema,
  warehouseId: objectIdSchema,
  warehouseName: z.string(),
  reason: z.enum(ADJUSTMENT_REASONS).nullable(),
  note: z.string(),
  docDate: z.string(),
  lines: z.array(z.strictObject({ ...stockDocLineBase, qty: z.string(), unitCost: z.string().nullable().optional(), value: z.string().nullable().optional() })),
  totalValue: z.string().nullable().optional(),
  createdBy: actorSchema,
  createdAt: z.iso.datetime(),
  postedBy: actorSchema,
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
});
export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;

// -------------------------------------------------------------- transfers

export const TRANSFER_STATUSES = ['draft', 'dispatched', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

const transferFields = {
  fromWarehouseId: objectIdSchema,
  toWarehouseId: objectIdSchema,
  docDate: businessDateSchema,
  note: z.string().trim().max(500).default(''),
  lines: z
    .array(z.strictObject({ itemId: objectIdSchema, qty: positiveQuantitySchema }))
    .min(1, 'Add at least one item')
    .max(200)
    .refine((lines) => new Set(lines.map((l) => l.itemId)).size === lines.length, 'Each item only once'),
};

export const stockTransferInputSchema = z.strictObject(transferFields).refine((t) => t.fromWarehouseId !== t.toWarehouseId, { path: ['toWarehouseId'], message: 'Choose a different warehouse' });
export const stockTransferUpdateSchema = z.strictObject({ ...patchShape(z.strictObject(transferFields).omit({ fromWarehouseId: true }).shape), version });

export const stockTransferSchema = z.strictObject({
  id: objectIdSchema,
  number: z.string(),
  status: z.enum(TRANSFER_STATUSES),
  legalEntityId: objectIdSchema,
  fromWarehouseId: objectIdSchema,
  fromWarehouseName: z.string(),
  toWarehouseId: objectIdSchema,
  toWarehouseName: z.string(),
  docDate: z.string(),
  note: z.string(),
  lines: z.array(z.strictObject({ ...stockDocLineBase, qty: z.string(), unitCost: z.string().nullable().optional(), value: z.string().nullable().optional() })),
  createdBy: actorSchema,
  createdAt: z.iso.datetime(),
  dispatchedBy: actorSchema,
  dispatchedAt: z.iso.datetime().nullable(),
  receivedBy: actorSchema,
  receivedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
  /** The transfer note PDF, made by the worker after dispatch. */
  pdf: documentArtifactSchema.nullable(),
  version: z.number().int(),
});
export type StockTransfer = z.infer<typeof stockTransferSchema>;

// ----------------------------------------------------------------- counts

export const COUNT_STATUSES = ['draft', 'counting', 'submitted', 'posted', 'cancelled'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const stockCountInputSchema = z
  .strictObject({
    warehouseId: objectIdSchema,
    note: z.string().trim().max(500).default(''),
    /** "all": every active stock item; "items": the listed ones. */
    scope: z.enum(['all', 'items']),
    itemIds: z
      .array(objectIdSchema)
      .max(2000)
      .refine((ids) => new Set(ids).size === ids.length, 'Each item only once')
      .default([]),
  })
  .refine((c) => c.scope === 'all' || c.itemIds.length > 0, { path: ['itemIds'], message: 'Choose the items to count' });

export const stockCountUpdateSchema = z.strictObject({
  version,
  note: z.string().trim().max(500).optional(),
  /** Counted quantities to record (null clears a count). Only items already on the count. */
  lines: z
    .array(z.strictObject({ itemId: objectIdSchema, countedQty: nonNegativeQuantitySchema.nullable(), unitCost: unitPriceSchema.nullable().optional() }))
    .max(2000)
    .optional(),
});

export const stockCountSchema = z.strictObject({
  id: objectIdSchema,
  number: z.string(),
  status: z.enum(COUNT_STATUSES),
  legalEntityId: objectIdSchema,
  warehouseId: objectIdSchema,
  warehouseName: z.string(),
  note: z.string(),
  scope: z.enum(['all', 'items']),
  /** When the expected quantities were taken. */
  snapshotAt: z.iso.datetime().nullable(),
  lines: z.array(
    z.strictObject({
      ...stockDocLineBase,
      expectedQty: z.string().nullable(),
      countedQty: z.string().nullable(),
      variance: z.string().nullable(),
      /** Cost for found stock of an item with no average cost yet. */
      unitCost: z.string().nullable().optional(),
    }),
  ),
  countedLines: z.number().int(),
  createdBy: actorSchema,
  createdAt: z.iso.datetime(),
  postedBy: actorSchema,
  postedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
});
export type StockCount = z.infer<typeof stockCountSchema>;

/** Shared list filters for stock documents. */
export const stockDocListQuerySchema = z.strictObject({
  legalEntityId: objectIdSchema.optional(),
  warehouseId: objectIdSchema.optional(),
  status: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdSchema.optional(),
});

// --------------------------------------------------------- reconciliation

export const RECONCILIATION_ISSUE_KINDS = ['on_hand', 'in_transit', 'reserved', 'valuation_qty', 'valuation_value', 'valuation_zero_qty'] as const;
export const RECONCILIATION_ISSUE_LABELS: Record<(typeof RECONCILIATION_ISSUE_KINDS)[number], string> = {
  on_hand: 'On hand differs from the stock ledger',
  in_transit: 'In transit differs from open transfers',
  reserved: 'Reserved differs from open sales orders',
  valuation_qty: 'Valued quantity differs from the stock ledger',
  valuation_value: 'Stock value differs from the stock ledger',
  valuation_zero_qty: 'Value left on an item with no stock',
};

export const reconciliationReportSchema = z.strictObject({
  checkedAt: z.iso.datetime(),
  legalEntityId: objectIdSchema.nullable(),
  balancesChecked: z.number().int(),
  valuationsChecked: z.number().int(),
  ok: z.boolean(),
  issues: z.array(
    z.strictObject({
      kind: z.enum(RECONCILIATION_ISSUE_KINDS),
      legalEntityId: objectIdSchema,
      warehouseId: objectIdSchema.nullable(),
      itemId: objectIdSchema,
      sku: z.string(),
      itemName: z.string(),
      /** Recomputed from movements (and open transfers). Omitted for values without price.view_cost. */
      expected: z.string().optional(),
      /** Stored on the balance or valuation record. */
      actual: z.string().optional(),
    }),
  ),
  /** Negative balances are allowed only with the entity's override; listed for review. */
  negativeBalances: z.array(z.strictObject({ legalEntityId: objectIdSchema, warehouseId: objectIdSchema, itemId: objectIdSchema, sku: z.string(), itemName: z.string(), onHand: z.string() })),
});
export type ReconciliationReport = z.infer<typeof reconciliationReportSchema>;
