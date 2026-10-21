import { Schema, type Types } from 'mongoose';
import type {
  AllocationTargetType,
  CreditNoteKind,
  DebitNoteKind,
  ExpenseCategory,
  ExpensePaymentMode,
  ExpenseStatus,
  NoteStatus,
  PaymentDirection,
  PaymentMethod,
  PaymentRecordStatus,
  RefundStatus,
} from '@bizmgmt/contracts';
import { tenantScoped } from './platform/tenant-scope.js';

type Decimal = Types.Decimal128;
const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;

// ------------------------------------------------------------ Payment
export interface PaymentDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  partyId: Types.ObjectId;
  partyName: string;
  direction: PaymentDirection;
  recordKind: 'payment' | 'credit_note_excess' | 'debit_note_excess';
  sourceNoteId: Types.ObjectId | null;
  sourceNoteNumber: string | null;
  amount: Decimal;
  unallocatedAmount: Decimal;
  paymentMethod: PaymentMethod;
  docDate: string;
  reference: string | null;
  bankAccountName: string | null;
  status: PaymentRecordStatus;
  number: string | null;
  notes: string;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  reversedAt: Date | null;
  reversedBy: Types.ObjectId | null;
  reversedReason: string | null;
  createdBy: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const paymentSchema = new Schema<PaymentDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    partyName: { type: String, required: true },
    direction: { type: String, required: true, enum: ['incoming', 'outgoing'] },
    recordKind: {
      type: String,
      required: true,
      enum: ['payment', 'credit_note_excess', 'debit_note_excess'],
      default: 'payment',
    },
    sourceNoteId: { type: objectId, default: null },
    sourceNoteNumber: { type: String, default: null },
    amount: { type: decimal, required: true },
    unallocatedAmount: { type: decimal, required: true },
    paymentMethod: { type: String, required: true, enum: ['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'credit'] },
    docDate: { type: String, required: true },
    reference: { type: String, default: null },
    bankAccountName: { type: String, default: null },
    status: { type: String, required: true, enum: ['draft', 'posted', 'reversed'], default: 'draft' },
    number: { type: String, default: null },
    notes: { type: String, default: '' },
    postedAt: { type: Date, default: null },
    postedBy: { type: objectId, default: null },
    reversedAt: { type: Date, default: null },
    reversedBy: { type: objectId, default: null },
    reversedReason: { type: String, default: null },
    createdBy: { type: objectId, required: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

paymentSchema.plugin(tenantScoped);
paymentSchema.index({ tenantId: 1, legalEntityId: 1, partyId: 1, status: 1 });
paymentSchema.index({ tenantId: 1, direction: 1, docDate: -1 });
paymentSchema.index({ tenantId: 1, number: 1 });

// ------------------------------------------------------------ Allocation
export interface AllocationDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  partyId: Types.ObjectId;
  paymentId: Types.ObjectId;
  targetType: AllocationTargetType;
  targetId: Types.ObjectId;
  targetNumber: string;
  amount: Decimal;
  allocatedAt: Date;
  allocatedBy: Types.ObjectId;
  status: 'active' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

export const allocationSchema = new Schema<AllocationDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    paymentId: { type: objectId, required: true },
    targetType: { type: String, required: true, enum: ['sales_invoice', 'supplier_bill'] },
    targetId: { type: objectId, required: true },
    targetNumber: { type: String, required: true },
    amount: { type: decimal, required: true },
    allocatedAt: { type: Date, required: true },
    allocatedBy: { type: objectId, required: true },
    status: { type: String, required: true, enum: ['active', 'cancelled'], default: 'active' },
  },
  { timestamps: true },
);

allocationSchema.plugin(tenantScoped);
allocationSchema.index({ tenantId: 1, paymentId: 1, status: 1 });
allocationSchema.index({ tenantId: 1, targetType: 1, targetId: 1, status: 1 });

// ------------------------------------------------------------ Refund
export interface RefundDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  partyId: Types.ObjectId;
  partyName: string;
  paymentId: Types.ObjectId;
  number: string | null;
  amount: Decimal;
  refundDate: string;
  paymentMethod: PaymentMethod;
  reference: string | null;
  reason: string;
  status: RefundStatus;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const refundSchema = new Schema<RefundDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    partyName: { type: String, required: true },
    paymentId: { type: objectId, required: true },
    number: { type: String, default: null },
    amount: { type: decimal, required: true },
    refundDate: { type: String, required: true },
    paymentMethod: { type: String, required: true, enum: ['cash', 'bank_transfer', 'upi', 'cheque', 'card'] },
    reference: { type: String, default: null },
    reason: { type: String, required: true },
    status: { type: String, required: true, enum: ['posted', 'reversed'], default: 'posted' },
    postedAt: { type: Date, default: null },
    postedBy: { type: objectId, default: null },
  },
  { timestamps: true },
);

refundSchema.plugin(tenantScoped);
refundSchema.index({ tenantId: 1, paymentId: 1 });
refundSchema.index({ tenantId: 1, legalEntityId: 1, refundDate: -1 });

// ------------------------------------------------------------ Expense
export interface ExpenseDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  number: string | null;
  category: string;
  description: string;
  docDate: string;
  amount: Decimal;
  taxableAmount: Decimal;
  taxAmount: Decimal;
  taxRate: Decimal | null;
  itcEligible: boolean;
  payeeName: string | null;
  paymentMode: ExpensePaymentMode;
  reference: string | null;
  notes: string;
  status: ExpenseStatus;
  postedAt: Date | null;
  postedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const expenseSchema = new Schema<ExpenseDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    number: { type: String, default: null },
    category: { type: String, required: true },
    description: { type: String, required: true },
    docDate: { type: String, required: true },
    amount: { type: decimal, required: true },
    taxableAmount: { type: decimal, required: true },
    taxAmount: { type: decimal, required: true },
    taxRate: { type: decimal, default: null },
    itcEligible: { type: Boolean, default: false },
    payeeName: { type: String, default: null },
    paymentMode: { type: String, required: true, enum: ['cash', 'bank_transfer', 'payable'] },
    reference: { type: String, default: null },
    notes: { type: String, default: '' },
    status: { type: String, required: true, enum: ['draft', 'posted', 'cancelled'], default: 'draft' },
    postedAt: { type: Date, default: null },
    postedBy: { type: objectId, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: objectId, default: null },
    cancelReason: { type: String, default: null },
    createdBy: { type: objectId, required: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

expenseSchema.plugin(tenantScoped);
expenseSchema.index({ tenantId: 1, legalEntityId: 1, docDate: -1 });
expenseSchema.index({ tenantId: 1, category: 1 });

// ------------------------------------------------------------ Credit & Debit Notes
export interface NoteLineDoc {
  lineId: string;
  sourceLineId: string | null;
  itemId: Types.ObjectId | null;
  itemName: string | null;
  sku: string | null;
  qty: Decimal | null;
  unitPrice: Decimal;
  taxRate: Decimal | null;
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  utgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  total: Decimal;
  reason: string | null;
}

export interface NoteAmountsDoc {
  taxable: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  utgst: Decimal;
  igst: Decimal;
  cess: Decimal;
  roundOff: Decimal;
  grand: Decimal;
}

const noteLineSchema = new Schema<NoteLineDoc>(
  {
    lineId: { type: String, required: true },
    sourceLineId: { type: String, default: null },
    itemId: { type: objectId, default: null },
    itemName: { type: String, default: null },
    sku: { type: String, default: null },
    qty: { type: decimal, default: null },
    unitPrice: { type: decimal, required: true },
    taxRate: { type: decimal, default: null },
    taxable: { type: decimal, required: true },
    cgst: { type: decimal, required: true },
    sgst: { type: decimal, required: true },
    utgst: { type: decimal, required: true },
    igst: { type: decimal, required: true },
    cess: { type: decimal, required: true },
    total: { type: decimal, required: true },
    reason: { type: String, default: null },
  },
  { _id: false },
);

const noteAmountsSchema = new Schema<NoteAmountsDoc>(
  {
    taxable: { type: decimal, required: true },
    cgst: { type: decimal, required: true },
    sgst: { type: decimal, required: true },
    utgst: { type: decimal, required: true },
    igst: { type: decimal, required: true },
    cess: { type: decimal, required: true },
    roundOff: { type: decimal, required: true },
    grand: { type: decimal, required: true },
  },
  { _id: false },
);

export interface CreditNoteDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  partyId: Types.ObjectId;
  partyName: string;
  salesInvoiceId: Types.ObjectId;
  salesInvoiceNumber: string;
  number: string | null;
  kind: CreditNoteKind;
  status: NoteStatus;
  docDate: string;
  reason: string;
  warehouseId: Types.ObjectId | null;
  lines: NoteLineDoc[];
  amounts: NoteAmountsDoc;
  notes: string;
  issuedAt: Date | null;
  issuedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const creditNoteSchema = new Schema<CreditNoteDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    partyName: { type: String, required: true },
    salesInvoiceId: { type: objectId, required: true },
    salesInvoiceNumber: { type: String, required: true },
    number: { type: String, default: null },
    kind: { type: String, required: true, enum: ['sales_return', 'price_adjustment'] },
    status: { type: String, required: true, enum: ['draft', 'issued', 'cancelled'], default: 'draft' },
    docDate: { type: String, required: true },
    reason: { type: String, required: true },
    warehouseId: { type: objectId, default: null },
    lines: { type: [noteLineSchema], required: true },
    amounts: { type: noteAmountsSchema, required: true },
    notes: { type: String, default: '' },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: objectId, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: objectId, default: null },
    cancelReason: { type: String, default: null },
    createdBy: { type: objectId, required: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

creditNoteSchema.plugin(tenantScoped);
creditNoteSchema.index({ tenantId: 1, legalEntityId: 1, partyId: 1 });
creditNoteSchema.index({ tenantId: 1, salesInvoiceId: 1 });
creditNoteSchema.index({ tenantId: 1, number: 1 });

export interface DebitNoteDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  partyId: Types.ObjectId;
  partyName: string;
  supplierBillId: Types.ObjectId;
  supplierBillNumber: string;
  number: string | null;
  kind: DebitNoteKind;
  status: NoteStatus;
  docDate: string;
  reason: string;
  warehouseId: Types.ObjectId | null;
  lines: NoteLineDoc[];
  amounts: NoteAmountsDoc;
  notes: string;
  issuedAt: Date | null;
  issuedBy: Types.ObjectId | null;
  cancelledAt: Date | null;
  cancelledBy: Types.ObjectId | null;
  cancelReason: string | null;
  createdBy: Types.ObjectId;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const debitNoteSchema = new Schema<DebitNoteDoc>(
  {
    tenantId: { type: objectId, required: true },
    legalEntityId: { type: objectId, required: true },
    partyId: { type: objectId, required: true },
    partyName: { type: String, required: true },
    supplierBillId: { type: objectId, required: true },
    supplierBillNumber: { type: String, required: true },
    number: { type: String, default: null },
    kind: { type: String, required: true, enum: ['purchase_return', 'price_adjustment'] },
    status: { type: String, required: true, enum: ['draft', 'issued', 'cancelled'], default: 'draft' },
    docDate: { type: String, required: true },
    reason: { type: String, required: true },
    warehouseId: { type: objectId, default: null },
    lines: { type: [noteLineSchema], required: true },
    amounts: { type: noteAmountsSchema, required: true },
    notes: { type: String, default: '' },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: objectId, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: objectId, default: null },
    cancelReason: { type: String, default: null },
    createdBy: { type: objectId, required: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);

debitNoteSchema.plugin(tenantScoped);
debitNoteSchema.index({ tenantId: 1, legalEntityId: 1, partyId: 1 });
debitNoteSchema.index({ tenantId: 1, supplierBillId: 1 });
debitNoteSchema.index({ tenantId: 1, number: 1 });
