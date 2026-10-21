import { Schema, type Types } from 'mongoose';
import type { AdjustmentReason, CountStatus, MovementKind, StockSourceType, TransferStatus } from '@bizmgmt/contracts';
import type { AddressDoc } from './models-business.js';
import { appendOnly, tenantScoped } from './platform/tenant-scope.js';

/**
 * Inventory collections (docs/database/schema.md §2 "Inventory", financial-policy.md §6–7).
 * Quantities are in the item's base unit; money and costs are Decimal128.
 */
type Decimal = Types.Decimal128;

const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;
const timestamps = { timestamps: true } as const;

/** Per-tenant counters for internal document references (TRF-000001…). Gaps are allowed: drafts can be cancelled. */
export interface CounterDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  key: string;
  next: number;
}

export const counterSchema = new Schema<CounterDoc>({
  tenantId: { type: objectId, required: true },
  key: { type: String, required: true },
  next: { type: Number, required: true },
});
counterSchema.index({ tenantId: 1, key: 1 }, { unique: true });
counterSchema.plugin(tenantScoped);

export interface WarehouseDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  code: string;
  name: string;
  nameKey: string;
  address: AddressDoc | null;
  gstRegistrationId: Types.ObjectId | null;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const warehouseSchema = new Schema<WarehouseDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    address: {
      type: new Schema<AddressDoc>(
        { line1: String, line2: { type: String, default: '' }, city: String, district: { type: String, default: '' }, stateCode: String, pincode: String },
        { _id: false },
      ),
      default: null,
    },
    gstRegistrationId: { type: objectId, default: null },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
warehouseSchema.index({ tenantId: 1, code: 1 }, { unique: true });
warehouseSchema.index({ tenantId: 1, legalEntityId: 1, nameKey: 1 });
warehouseSchema.plugin(tenantScoped);

/**
 * One stock change. Append-only (FR-INV-03): corrections are new movements with
 * `reversalOf`. The unique key (source, line, kind, reversal) makes a document
 * line move stock at most once (FR-INV-10) even if a command is replayed.
 */
export interface StockMovementDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  itemId: Types.ObjectId;
  kind: MovementKind;
  /** Signed; 0 for value-only revaluations. */
  qty: Decimal;
  onHandAfter: Decimal;
  unitCost: Decimal;
  /** Signed, 2 dp: the change in stock value. */
  value: Decimal;
  sourceType: StockSourceType;
  sourceId: Types.ObjectId;
  sourceNumber: string;
  sourceLineId: string;
  docDate: string;
  reversalOf: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

export const stockMovementSchema = new Schema<StockMovementDoc>({
  tenantId: { type: objectId, required: true },
  legalEntityId: { type: objectId, required: true },
  warehouseId: { type: objectId, required: true },
  itemId: { type: objectId, required: true },
  kind: { type: String, required: true },
  qty: { type: decimal, required: true },
  onHandAfter: { type: decimal, required: true },
  unitCost: { type: decimal, required: true },
  value: { type: decimal, required: true },
  sourceType: { type: String, required: true },
  sourceId: { type: objectId, required: true },
  sourceNumber: { type: String, required: true },
  sourceLineId: { type: String, required: true },
  docDate: { type: String, required: true },
  reversalOf: { type: objectId, default: null },
  createdBy: { type: objectId, required: true },
  createdAt: { type: Date, required: true },
});
stockMovementSchema.index({ tenantId: 1, legalEntityId: 1, itemId: 1, docDate: 1 });
stockMovementSchema.index({ tenantId: 1, warehouseId: 1, itemId: 1, _id: -1 });
stockMovementSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
stockMovementSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1, sourceLineId: 1, kind: 1, reversalOf: 1 }, { unique: true });
stockMovementSchema.plugin(tenantScoped);
stockMovementSchema.plugin(appendOnly);

/** Running balance per (warehouse, item). Updated only in the same transaction as the movement that changes it. */
export interface StockBalanceDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  itemId: Types.ObjectId;
  onHand: Decimal;
  reserved: Decimal;
  /** Incoming from open transfers. */
  inTransit: Decimal;
  version: number;
}

export const stockBalanceSchema = new Schema<StockBalanceDoc>({
  tenantId: { type: objectId, required: true },
  legalEntityId: { type: objectId, required: true },
  warehouseId: { type: objectId, required: true },
  itemId: { type: objectId, required: true },
  onHand: { type: decimal, required: true },
  reserved: { type: decimal, required: true },
  inTransit: { type: decimal, required: true },
  version: { type: Number, default: 0 },
});
stockBalanceSchema.index({ tenantId: 1, warehouseId: 1, itemId: 1 }, { unique: true });
stockBalanceSchema.index({ tenantId: 1, legalEntityId: 1, itemId: 1 });
stockBalanceSchema.plugin(tenantScoped);

/** Moving-average state per (legal entity, item): quantity includes goods in transit between the entity's warehouses. */
export interface ItemValuationDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  itemId: Types.ObjectId;
  qty: Decimal;
  value: Decimal;
  avgCost: Decimal | null;
  version: number;
}

export const itemValuationSchema = new Schema<ItemValuationDoc>({
  tenantId: { type: objectId, required: true },
  legalEntityId: { type: objectId, required: true },
  itemId: { type: objectId, required: true },
  qty: { type: decimal, required: true },
  value: { type: decimal, required: true },
  avgCost: { type: decimal, default: null },
  version: { type: Number, default: 0 },
});
itemValuationSchema.index({ tenantId: 1, legalEntityId: 1, itemId: 1 }, { unique: true });
itemValuationSchema.plugin(tenantScoped);

// ------------------------------------------------------------ documents

export interface StockDocLine {
  lineId: string;
  itemId: Types.ObjectId;
  qty: Decimal;
  /** Set when posted (adjustments) or dispatched (transfers); null on drafts. */
  unitCost: Decimal | null;
  value: Decimal | null;
}

const stockDocLineSchema = new Schema<StockDocLine>(
  {
    lineId: { type: String, required: true },
    itemId: { type: objectId, required: true },
    qty: { type: decimal, required: true },
    unitCost: { type: decimal, default: null },
    value: { type: decimal, default: null },
  },
  { _id: false },
);

export interface StockAdjustmentDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  number: string;
  type: 'opening' | 'adjustment';
  status: 'draft' | 'posted' | 'cancelled';
  reason: AdjustmentReason | null;
  note: string;
  docDate: string;
  lines: StockDocLine[];
  createdBy: Types.ObjectId;
  postedBy: Types.ObjectId | null;
  postedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const stockAdjustmentSchema = new Schema<StockAdjustmentDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    warehouseId: { type: objectId, required: true },
    number: { type: String, required: true },
    type: { type: String, enum: ['opening', 'adjustment'], required: true },
    status: { type: String, enum: ['draft', 'posted', 'cancelled'], required: true },
    reason: { type: String, default: null },
    note: { type: String, default: '' },
    docDate: { type: String, required: true },
    lines: { type: [stockDocLineSchema], default: [] },
    createdBy: { type: objectId, required: true },
    postedBy: { type: objectId, default: null },
    postedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
stockAdjustmentSchema.index({ tenantId: 1, number: 1 }, { unique: true });
stockAdjustmentSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
stockAdjustmentSchema.plugin(tenantScoped);

export interface StockTransferDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  fromWarehouseId: Types.ObjectId;
  toWarehouseId: Types.ObjectId;
  number: string;
  status: TransferStatus;
  docDate: string;
  note: string;
  lines: StockDocLine[];
  createdBy: Types.ObjectId;
  dispatchedBy: Types.ObjectId | null;
  dispatchedAt: Date | null;
  receivedBy: Types.ObjectId | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const stockTransferSchema = new Schema<StockTransferDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    fromWarehouseId: { type: objectId, required: true },
    toWarehouseId: { type: objectId, required: true },
    number: { type: String, required: true },
    status: { type: String, enum: ['draft', 'dispatched', 'received', 'cancelled'], required: true },
    docDate: { type: String, required: true },
    note: { type: String, default: '' },
    lines: { type: [stockDocLineSchema], default: [] },
    createdBy: { type: objectId, required: true },
    dispatchedBy: { type: objectId, default: null },
    dispatchedAt: { type: Date, default: null },
    receivedBy: { type: objectId, default: null },
    receivedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
stockTransferSchema.index({ tenantId: 1, number: 1 }, { unique: true });
stockTransferSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
// Reconciliation sums open (dispatched) transfers per destination.
stockTransferSchema.index({ tenantId: 1, status: 1, toWarehouseId: 1 });
stockTransferSchema.plugin(tenantScoped);

export interface StockCountLine {
  lineId: string;
  itemId: Types.ObjectId;
  expectedQty: Decimal | null;
  countedQty: Decimal | null;
  unitCost: Decimal | null;
}

export interface StockCountDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  warehouseId: Types.ObjectId;
  number: string;
  status: CountStatus;
  note: string;
  scope: 'all' | 'items';
  snapshotAt: Date | null;
  lines: StockCountLine[];
  createdBy: Types.ObjectId;
  postedBy: Types.ObjectId | null;
  postedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const stockCountSchema = new Schema<StockCountDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    warehouseId: { type: objectId, required: true },
    number: { type: String, required: true },
    status: { type: String, enum: ['draft', 'counting', 'submitted', 'posted', 'cancelled'], required: true },
    note: { type: String, default: '' },
    scope: { type: String, enum: ['all', 'items'], required: true },
    snapshotAt: { type: Date, default: null },
    lines: {
      type: [
        new Schema<StockCountLine>(
          {
            lineId: { type: String, required: true },
            itemId: { type: objectId, required: true },
            expectedQty: { type: decimal, default: null },
            countedQty: { type: decimal, default: null },
            unitCost: { type: decimal, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    createdBy: { type: objectId, required: true },
    postedBy: { type: objectId, default: null },
    postedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
stockCountSchema.index({ tenantId: 1, number: 1 }, { unique: true });
stockCountSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
stockCountSchema.plugin(tenantScoped);
