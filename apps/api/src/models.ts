import { Schema, type Connection, type Types } from 'mongoose';
import type { AuditAction, AuditChange, SystemRoleKey, ThemePreference } from '@bizmgmt/contracts';
import {
  categorySchema,
  crmNoteSchema,
  crmTaskSchema,
  documentSeriesSchema,
  gstRegistrationSchema,
  itemSchema,
  legalEntitySchema,
  partySchema,
  sequenceSchema,
  taxClassSchema,
  unitSchema,
} from './models-business.js';
import { accountSchema, documentArtifactSchema, fileSchema, idempotencyKeySchema, integrityCheckSchema, jobLockSchema, journalSchema, outboxSchema } from './models-finance.js';
import { counterSchema, itemValuationSchema, stockAdjustmentSchema, stockBalanceSchema, stockCountSchema, stockMovementSchema, stockTransferSchema, warehouseSchema } from './models-inventory.js';
import { dispatchSchema, quotationSchema, salesInvoiceSchema, salesOrderSchema } from './models-sales.js';
import { goodsReceiptSchema, purchaseOrderSchema, supplierBillSchema, type GoodsReceiptDoc, type PurchaseOrderDoc, type SupplierBillDoc } from './models-purchases.js';
import {
  allocationSchema,
  creditNoteSchema,
  debitNoteSchema,
  expenseSchema,
  paymentSchema,
  refundSchema,
  type AllocationDoc,
  type CreditNoteDoc,
  type DebitNoteDoc,
  type ExpenseDoc,
  type PaymentDoc,
  type RefundDoc,
} from './models-payments.js';
import { appendOnly, tenantScoped } from './platform/tenant-scope.js';

export type * from './models-business.js';
export type * from './models-inventory.js';
export type * from './models-finance.js';
export type * from './models-sales.js';
export type * from './models-purchases.js';
export type * from './models-payments.js';

/** Collection layout: docs/database/schema.md §2 (identity, tenancy, audit, platform). */

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  status: 'active' | 'disabled';
  mfaEnabled: boolean;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  lastTenantId: Types.ObjectId | null;
  preferences: { theme: ThemePreference };
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionDoc {
  _id: Types.ObjectId;
  tokenHash: string;
  userId: Types.ObjectId;
  /** "pending": password verified, MFA code still required. */
  mfaState: 'pending' | 'complete';
  mfaVerifiedAt: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  ipHash: string;
  userAgent: string;
  revokedAt: Date | null;
}

export interface MfaFactorDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  type: 'totp';
  status: 'pending' | 'active';
  secretEnc: string;
  lastUsedStep: number;
  recoveryCodeHashes: string[];
  createdAt: Date;
  confirmedAt: Date | null;
}

export interface PasswordResetDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface RateLimitDoc {
  _id: Types.ObjectId;
  key: string;
  windowStart: Date;
  count: number;
  blockedUntil: Date | null;
  expiresAt: Date;
}

export interface TenantDoc {
  _id: Types.ObjectId;
  name: string;
  status: 'active' | 'suspended';
  createdBy: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  name: string;
  /** Lower-cased name for case-insensitive uniqueness. */
  nameKey: string;
  description: string;
  /** Set for system roles; their permissions come from code (contracts/permissions.ts), not this document. */
  systemKey: SystemRoleKey | null;
  permissions: string[];
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoleAssignment {
  roleId: Types.ObjectId;
  /** null = all legal entities / all warehouses (of those entities). */
  legalEntityIds: Types.ObjectId[] | null;
  warehouseIds: Types.ObjectId[] | null;
}

export interface MembershipDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  status: 'active' | 'disabled';
  roleAssignments: RoleAssignment[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InvitationDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  email: string;
  roleIds: Types.ObjectId[];
  /** null = all legal entities. */
  legalEntityIds: Types.ObjectId[] | null;
  /** null = all warehouses of those entities. */
  warehouseIds: Types.ObjectId[] | null;
  tokenHash: string;
  invitedBy: Types.ObjectId;
  status: 'pending' | 'accepted' | 'revoked';
  expiresAt: Date;
  acceptedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditEventDoc {
  _id: Types.ObjectId;
  /** null for user-level security events (sign-in, MFA) that are not tied to a tenant. */
  tenantId: Types.ObjectId | null;
  at: Date;
  actorId: Types.ObjectId | null;
  /** The account the event is about, for user-level events. */
  subjectUserId: Types.ObjectId | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  summary: string;
  changes: AuditChange[];
  requestId: string;
  ipHash: string;
}

const timestamps = { timestamps: true } as const;
const objectId = Schema.Types.ObjectId;

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    mfaEnabled: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    lastTenantId: { type: objectId, default: null },
    preferences: { theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' } },
    passwordChangedAt: { type: Date, required: true },
  },
  timestamps,
);
userSchema.index({ email: 1 }, { unique: true });

const sessionSchema = new Schema<SessionDoc>({
  tokenHash: { type: String, required: true },
  userId: { type: objectId, required: true },
  mfaState: { type: String, enum: ['pending', 'complete'], required: true },
  mfaVerifiedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
  lastSeenAt: { type: Date, required: true },
  idleExpiresAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  ipHash: { type: String, required: true },
  userAgent: { type: String, default: '' },
  revokedAt: { type: Date, default: null },
});
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ absoluteExpiresAt: 1 }, { expireAfterSeconds: 0 });

const mfaFactorSchema = new Schema<MfaFactorDoc>({
  userId: { type: objectId, required: true },
  type: { type: String, enum: ['totp'], required: true },
  status: { type: String, enum: ['pending', 'active'], required: true },
  secretEnc: { type: String, required: true },
  lastUsedStep: { type: Number, default: -1 },
  recoveryCodeHashes: { type: [String], default: [] },
  createdAt: { type: Date, required: true },
  confirmedAt: { type: Date, default: null },
});
mfaFactorSchema.index({ userId: 1, type: 1 }, { unique: true });

const passwordResetSchema = new Schema<PasswordResetDoc>({
  userId: { type: objectId, required: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, required: true },
});
passwordResetSchema.index({ tokenHash: 1 }, { unique: true });
passwordResetSchema.index({ userId: 1 });
passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const rateLimitSchema = new Schema<RateLimitDoc>({
  key: { type: String, required: true },
  windowStart: { type: Date, required: true },
  count: { type: Number, required: true },
  blockedUntil: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
});
rateLimitSchema.index({ key: 1 }, { unique: true });
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const tenantSchema = new Schema<TenantDoc>(
  {
    name: { type: String, required: true },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    createdBy: { type: objectId, required: true },
    version: { type: Number, default: 0 },
  },
  timestamps,
);

const roleSchema = new Schema<RoleDoc>(
  {
    tenantId: { type: objectId, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    description: { type: String, default: '' },
    systemKey: { type: String, default: null },
    permissions: { type: [String], default: [] },
    archivedAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
roleSchema.index({ tenantId: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { archivedAt: null } });
roleSchema.plugin(tenantScoped);

const roleAssignmentSchema = new Schema<RoleAssignment>(
  {
    roleId: { type: objectId, required: true },
    legalEntityIds: { type: [objectId], default: null },
    warehouseIds: { type: [objectId], default: null },
  },
  { _id: false },
);

const membershipSchema = new Schema<MembershipDoc>(
  {
    tenantId: { type: objectId, required: true },
    userId: { type: objectId, required: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    roleAssignments: { type: [roleAssignmentSchema], default: [] },
    version: { type: Number, default: 0 },
  },
  timestamps,
);
membershipSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });
membershipSchema.index({ tenantId: 1, 'roleAssignments.roleId': 1 });
membershipSchema.plugin(tenantScoped);

const invitationSchema = new Schema<InvitationDoc>(
  {
    tenantId: { type: objectId, required: true },
    email: { type: String, required: true },
    roleIds: { type: [objectId], required: true },
    legalEntityIds: { type: [objectId], default: null },
    warehouseIds: { type: [objectId], default: null },
    tokenHash: { type: String, required: true },
    invitedBy: { type: objectId, required: true },
    status: { type: String, enum: ['pending', 'accepted', 'revoked'], default: 'pending' },
    expiresAt: { type: Date, required: true },
    acceptedBy: { type: objectId, default: null },
  },
  timestamps,
);
invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ tenantId: 1, email: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
invitationSchema.plugin(tenantScoped);

const auditChangeSchema = new Schema<AuditChange>(
  { field: { type: String, required: true }, from: { type: Schema.Types.Mixed }, to: { type: Schema.Types.Mixed } },
  { _id: false, minimize: false },
);

const auditEventSchema = new Schema<AuditEventDoc>({
  tenantId: { type: objectId, default: null },
  at: { type: Date, required: true },
  actorId: { type: objectId, default: null },
  subjectUserId: { type: objectId, default: null },
  action: { type: String, required: true },
  entityType: { type: String, required: true },
  entityId: { type: String, default: null },
  summary: { type: String, required: true },
  changes: { type: [auditChangeSchema], default: [] },
  requestId: { type: String, required: true },
  ipHash: { type: String, required: true },
});
auditEventSchema.index({ tenantId: 1, _id: -1 });
auditEventSchema.index({ tenantId: 1, entityType: 1, entityId: 1, _id: -1 });
auditEventSchema.index({ subjectUserId: 1, _id: -1 });
auditEventSchema.plugin(tenantScoped);
auditEventSchema.plugin(appendOnly);

export function createModels(connection: Connection) {
  // autoIndex is off: indexes are created by migrations (schema.md §4), never implicitly at start-up.
  const options = { autoIndex: false, autoCreate: false } as const;
  const schemas = [
    userSchema,
    sessionSchema,
    mfaFactorSchema,
    passwordResetSchema,
    rateLimitSchema,
    tenantSchema,
    roleSchema,
    membershipSchema,
    invitationSchema,
    auditEventSchema,
    legalEntitySchema,
    gstRegistrationSchema,
    documentSeriesSchema,
    sequenceSchema,
    unitSchema,
    categorySchema,
    taxClassSchema,
    itemSchema,
    partySchema,
    crmNoteSchema,
    crmTaskSchema,
    counterSchema,
    warehouseSchema,
    stockMovementSchema,
    stockBalanceSchema,
    itemValuationSchema,
    stockAdjustmentSchema,
    stockTransferSchema,
    stockCountSchema,
    idempotencyKeySchema,
    accountSchema,
    journalSchema,
    outboxSchema,
    fileSchema,
    documentArtifactSchema,
    jobLockSchema,
    integrityCheckSchema,
    quotationSchema,
    salesOrderSchema,
    dispatchSchema,
    salesInvoiceSchema,
    purchaseOrderSchema,
    goodsReceiptSchema,
    supplierBillSchema,
    paymentSchema,
    allocationSchema,
    refundSchema,
    expenseSchema,
    creditNoteSchema,
    debitNoteSchema,
  ];
  for (const schema of schemas) {
    schema.set('autoIndex', options.autoIndex);
    schema.set('autoCreate', options.autoCreate);
    schema.set('strict', 'throw');
  }
  return {
    User: connection.model('User', userSchema, 'users'),
    Session: connection.model('Session', sessionSchema, 'sessions'),
    MfaFactor: connection.model('MfaFactor', mfaFactorSchema, 'mfaFactors'),
    PasswordReset: connection.model('PasswordReset', passwordResetSchema, 'passwordResets'),
    RateLimit: connection.model('RateLimit', rateLimitSchema, 'rateLimits'),
    Tenant: connection.model('Tenant', tenantSchema, 'tenants'),
    Role: connection.model('Role', roleSchema, 'roles'),
    Membership: connection.model('Membership', membershipSchema, 'memberships'),
    Invitation: connection.model('Invitation', invitationSchema, 'invitations'),
    AuditEvent: connection.model('AuditEvent', auditEventSchema, 'auditEvents'),
    LegalEntity: connection.model('LegalEntity', legalEntitySchema, 'legalEntities'),
    GstRegistration: connection.model('GstRegistration', gstRegistrationSchema, 'gstRegistrations'),
    DocumentSeries: connection.model('DocumentSeries', documentSeriesSchema, 'documentSeries'),
    Sequence: connection.model('Sequence', sequenceSchema, 'sequences'),
    Unit: connection.model('Unit', unitSchema, 'units'),
    Category: connection.model('Category', categorySchema, 'categories'),
    TaxClass: connection.model('TaxClass', taxClassSchema, 'taxClasses'),
    Item: connection.model('Item', itemSchema, 'items'),
    Party: connection.model('Party', partySchema, 'parties'),
    CrmNote: connection.model('CrmNote', crmNoteSchema, 'crmNotes'),
    CrmTask: connection.model('CrmTask', crmTaskSchema, 'crmTasks'),
    Counter: connection.model('Counter', counterSchema, 'counters'),
    Warehouse: connection.model('Warehouse', warehouseSchema, 'warehouses'),
    StockMovement: connection.model('StockMovement', stockMovementSchema, 'stockMovements'),
    StockBalance: connection.model('StockBalance', stockBalanceSchema, 'stockBalances'),
    ItemValuation: connection.model('ItemValuation', itemValuationSchema, 'itemValuations'),
    StockAdjustment: connection.model('StockAdjustment', stockAdjustmentSchema, 'stockAdjustments'),
    StockTransfer: connection.model('StockTransfer', stockTransferSchema, 'stockTransfers'),
    StockCount: connection.model('StockCount', stockCountSchema, 'stockCounts'),
    IdempotencyKey: connection.model('IdempotencyKey', idempotencyKeySchema, 'idempotencyKeys'),
    Account: connection.model('Account', accountSchema, 'accounts'),
    Journal: connection.model('Journal', journalSchema, 'journals'),
    Outbox: connection.model('Outbox', outboxSchema, 'outbox'),
    File: connection.model('File', fileSchema, 'files'),
    DocumentArtifact: connection.model('DocumentArtifact', documentArtifactSchema, 'documentArtifacts'),
    JobLock: connection.model('JobLock', jobLockSchema, 'jobLocks'),
    IntegrityCheck: connection.model('IntegrityCheck', integrityCheckSchema, 'integrityChecks'),
    Quotation: connection.model('Quotation', quotationSchema, 'quotations'),
    SalesOrder: connection.model('SalesOrder', salesOrderSchema, 'salesOrders'),
    Dispatch: connection.model('Dispatch', dispatchSchema, 'dispatches'),
    SalesInvoice: connection.model('SalesInvoice', salesInvoiceSchema, 'salesInvoices'),
    PurchaseOrder: connection.model<PurchaseOrderDoc>('PurchaseOrder', purchaseOrderSchema, 'purchaseOrders'),
    GoodsReceipt: connection.model<GoodsReceiptDoc>('GoodsReceipt', goodsReceiptSchema, 'goodsReceipts'),
    SupplierBill: connection.model<SupplierBillDoc>('SupplierBill', supplierBillSchema, 'supplierBills'),
    Payment: connection.model<PaymentDoc>('Payment', paymentSchema, 'payments'),
    Allocation: connection.model<AllocationDoc>('Allocation', allocationSchema, 'allocations'),
    Refund: connection.model<RefundDoc>('Refund', refundSchema, 'refunds'),
    Expense: connection.model<ExpenseDoc>('Expense', expenseSchema, 'expenses'),
    CreditNote: connection.model<CreditNoteDoc>('CreditNote', creditNoteSchema, 'creditNotes'),
    DebitNote: connection.model<DebitNoteDoc>('DebitNote', debitNoteSchema, 'debitNotes'),
  };
}

export type Models = ReturnType<typeof createModels>;
