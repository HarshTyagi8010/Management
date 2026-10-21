import { z } from 'zod';
import { businessDateSchema, nonNegativeMoneySchema, objectIdSchema, paginationQuerySchema, taxRateSchema, unitPriceSchema } from './primitives.js';

export const positiveMoneySchema = nonNegativeMoneySchema.refine(
  (v) => !v.startsWith('-') && /[1-9]/.test(v),
  'Enter an amount more than zero',
);

// ------------------------------------------------------------ Payments & Allocations
export const PAYMENT_DIRECTIONS = ['incoming', 'outgoing'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'upi', 'cheque', 'card', 'credit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_RECORD_KINDS = ['payment', 'credit_note_excess', 'debit_note_excess'] as const;
export type PaymentRecordKind = (typeof PAYMENT_RECORD_KINDS)[number];

export const PAYMENT_RECORD_STATUSES = ['draft', 'posted', 'reversed'] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const ALLOCATION_TARGET_TYPES = ['sales_invoice', 'supplier_bill'] as const;
export type AllocationTargetType = (typeof ALLOCATION_TARGET_TYPES)[number];

export const allocationItemInputSchema = z.strictObject({
  targetType: z.enum(ALLOCATION_TARGET_TYPES),
  targetId: objectIdSchema,
  amount: positiveMoneySchema,
});
export type AllocationItemInput = z.infer<typeof allocationItemInputSchema>;

export const createPaymentSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  partyId: objectIdSchema,
  direction: z.enum(PAYMENT_DIRECTIONS),
  amount: positiveMoneySchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  docDate: businessDateSchema,
  reference: z.string().trim().max(100).optional(),
  bankAccountName: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
  allocations: z.array(allocationItemInputSchema).optional(),
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const allocatePaymentSchema = z.strictObject({
  allocations: z.array(allocationItemInputSchema).min(1, 'Provide at least one allocation'),
});
export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;

export const fifoAllocateSchema = z.strictObject({
  maxAmount: positiveMoneySchema.optional(),
});
export type FifoAllocateInput = z.infer<typeof fifoAllocateSchema>;

export const reversePaymentSchema = z.strictObject({
  reason: z.string().trim().min(3, 'Provide a reason for reversal').max(500),
  reversalDate: businessDateSchema.optional(),
});
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

export const paymentAllocationResponseSchema = z.strictObject({
  id: z.string(),
  paymentId: z.string(),
  targetType: z.enum(ALLOCATION_TARGET_TYPES),
  targetId: z.string(),
  targetNumber: z.string(),
  amount: z.string(),
  allocatedAt: z.string(),
  allocatedBy: z.string(),
  status: z.enum(['active', 'cancelled']),
});
export type PaymentAllocationResponse = z.infer<typeof paymentAllocationResponseSchema>;

export const paymentResponseSchema = z.strictObject({
  id: z.string(),
  number: z.string().nullable(),
  direction: z.enum(PAYMENT_DIRECTIONS),
  partyId: z.string(),
  partyName: z.string(),
  legalEntityId: z.string(),
  amount: z.string(),
  unallocatedAmount: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  docDate: z.string(),
  reference: z.string().nullable(),
  bankAccountName: z.string().nullable(),
  status: z.enum(PAYMENT_RECORD_STATUSES),
  recordKind: z.enum(PAYMENT_RECORD_KINDS).default('payment').optional(),
  sourceNoteId: z.string().nullable().optional(),
  sourceNoteNumber: z.string().nullable().optional(),
  notes: z.string(),
  postedAt: z.string().nullable(),
  postedBy: z.string().nullable(),
  reversedAt: z.string().nullable(),
  reversedBy: z.string().nullable(),
  reversedReason: z.string().nullable(),
  allocations: z.array(paymentAllocationResponseSchema),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

export const paymentListQuerySchema = paginationQuerySchema.extend({
  legalEntityId: objectIdSchema.optional(),
  partyId: objectIdSchema.optional(),
  direction: z.enum(PAYMENT_DIRECTIONS).optional(),
  status: z.enum(PAYMENT_RECORD_STATUSES).optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

// ------------------------------------------------------------ Refunds
export const REFUND_STATUSES = ['posted', 'reversed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

export const createRefundSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  partyId: objectIdSchema,
  paymentId: objectIdSchema,
  amount: positiveMoneySchema,
  refundDate: businessDateSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  reference: z.string().trim().max(100).optional(),
  reason: z.string().trim().min(3, 'Provide a reason for refund').max(500),
});
export type CreateRefundInput = z.infer<typeof createRefundSchema>;

export const refundResponseSchema = z.strictObject({
  id: z.string(),
  number: z.string().nullable(),
  paymentId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  legalEntityId: z.string(),
  amount: z.string(),
  refundDate: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  reference: z.string().nullable(),
  reason: z.string(),
  status: z.enum(REFUND_STATUSES),
  postedAt: z.string().nullable(),
  postedBy: z.string().nullable(),
  createdAt: z.string(),
});
export type RefundResponse = z.infer<typeof refundResponseSchema>;

// ------------------------------------------------------------ Expenses
export const EXPENSE_CATEGORIES = [
  'Rent',
  'Utilities',
  'Office Supplies',
  'Legal & Professional',
  'Travel & Entertainment',
  'Repairs & Maintenance',
  'Salaries & Wages',
  'Marketing & Advertising',
  'Freight & Courier',
  'Insurance',
  'Bank Charges',
  'Software & Subscriptions',
  'General & Administrative',
  'Other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_PAYMENT_MODES = ['cash', 'bank_transfer', 'payable'] as const;
export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];

export const EXPENSE_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const createExpenseSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  category: z.string().trim().min(1, 'Category is required').max(100),
  description: z.string().trim().min(2, 'Description is required').max(500),
  docDate: businessDateSchema,
  amount: positiveMoneySchema,
  payeeName: z.string().trim().max(200).optional(),
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
  taxRate: taxRateSchema.optional(),
  itcEligible: z.boolean().default(false),
  reference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const expenseResponseSchema = z.strictObject({
  id: z.string(),
  number: z.string().nullable(),
  legalEntityId: z.string(),
  category: z.string(),
  description: z.string(),
  docDate: z.string(),
  amount: z.string(),
  taxableAmount: z.string(),
  taxAmount: z.string(),
  taxRate: z.string().nullable(),
  itcEligible: z.boolean(),
  payeeName: z.string().nullable(),
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
  reference: z.string().nullable(),
  notes: z.string(),
  status: z.enum(EXPENSE_STATUSES),
  postedAt: z.string().nullable(),
  postedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExpenseResponse = z.infer<typeof expenseResponseSchema>;

export const expenseListQuerySchema = paginationQuerySchema.extend({
  legalEntityId: objectIdSchema.optional(),
  category: z.string().optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;

// ------------------------------------------------------------ Credit & Debit Notes
export const CREDIT_NOTE_KINDS = ['sales_return', 'price_adjustment'] as const;
export type CreditNoteKind = (typeof CREDIT_NOTE_KINDS)[number];

export const DEBIT_NOTE_KINDS = ['purchase_return', 'price_adjustment'] as const;
export type DebitNoteKind = (typeof DEBIT_NOTE_KINDS)[number];

export const NOTE_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const noteLineInputSchema = z.strictObject({
  sourceLineId: z.string().optional(),
  itemId: objectIdSchema.optional(),
  qty: positiveMoneySchema.optional(),
  unitPrice: unitPriceSchema,
  taxRate: taxRateSchema.optional(),
  reason: z.string().trim().max(200).optional(),
});
export type NoteLineInput = z.infer<typeof noteLineInputSchema>;

export const createCreditNoteSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  partyId: objectIdSchema,
  salesInvoiceId: objectIdSchema,
  kind: z.enum(CREDIT_NOTE_KINDS),
  docDate: businessDateSchema,
  reason: z.string().trim().min(3, 'Reason is required').max(500),
  warehouseId: objectIdSchema.optional(),
  lines: z.array(noteLineInputSchema).min(1, 'Provide at least one line'),
  notes: z.string().trim().max(500).optional(),
});
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

export const createDebitNoteSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  partyId: objectIdSchema,
  supplierBillId: objectIdSchema,
  kind: z.enum(DEBIT_NOTE_KINDS),
  docDate: businessDateSchema,
  reason: z.string().trim().min(3, 'Reason is required').max(500),
  warehouseId: objectIdSchema.optional(),
  lines: z.array(noteLineInputSchema).min(1, 'Provide at least one line'),
  notes: z.string().trim().max(500).optional(),
});
export type CreateDebitNoteInput = z.infer<typeof createDebitNoteSchema>;

export const noteAmountsSchema = z.strictObject({
  taxable: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  utgst: z.string(),
  igst: z.string(),
  cess: z.string(),
  roundOff: z.string(),
  grand: z.string(),
});
export type NoteAmounts = z.infer<typeof noteAmountsSchema>;

export const noteLineResponseSchema = z.strictObject({
  lineId: z.string(),
  sourceLineId: z.string().nullable(),
  itemId: z.string().nullable(),
  itemName: z.string().nullable(),
  sku: z.string().nullable(),
  qty: z.string().nullable(),
  unitPrice: z.string(),
  taxRate: z.string().nullable(),
  taxable: z.string(),
  cgst: z.string(),
  sgst: z.string(),
  utgst: z.string(),
  igst: z.string(),
  cess: z.string(),
  total: z.string(),
  reason: z.string().nullable(),
});
export type NoteLineResponse = z.infer<typeof noteLineResponseSchema>;

export const creditNoteResponseSchema = z.strictObject({
  id: z.string(),
  number: z.string().nullable(),
  legalEntityId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  salesInvoiceId: z.string(),
  salesInvoiceNumber: z.string(),
  kind: z.enum(CREDIT_NOTE_KINDS),
  status: z.enum(NOTE_STATUSES),
  docDate: z.string(),
  reason: z.string(),
  warehouseId: z.string().nullable(),
  lines: z.array(noteLineResponseSchema),
  amounts: noteAmountsSchema,
  notes: z.string(),
  issuedAt: z.string().nullable(),
  issuedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CreditNoteResponse = z.infer<typeof creditNoteResponseSchema>;

export const debitNoteResponseSchema = z.strictObject({
  id: z.string(),
  number: z.string().nullable(),
  legalEntityId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  supplierBillId: z.string(),
  supplierBillNumber: z.string(),
  kind: z.enum(DEBIT_NOTE_KINDS),
  status: z.enum(NOTE_STATUSES),
  docDate: z.string(),
  reason: z.string(),
  warehouseId: z.string().nullable(),
  lines: z.array(noteLineResponseSchema),
  amounts: noteAmountsSchema,
  notes: z.string(),
  issuedAt: z.string().nullable(),
  issuedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  cancelReason: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DebitNoteResponse = z.infer<typeof debitNoteResponseSchema>;

export const noteListQuerySchema = paginationQuerySchema.extend({
  legalEntityId: objectIdSchema.optional(),
  partyId: objectIdSchema.optional(),
  kind: z.string().optional(),
  status: z.enum(NOTE_STATUSES).optional(),
  from: businessDateSchema.optional(),
  to: businessDateSchema.optional(),
});
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;

// ------------------------------------------------------------ Statements
export const partyStatementQuerySchema = z.strictObject({
  legalEntityId: objectIdSchema,
  partyId: objectIdSchema,
  from: businessDateSchema,
  to: businessDateSchema,
});
export type PartyStatementQuery = z.infer<typeof partyStatementQuerySchema>;

export const statementEntrySchema = z.strictObject({
  date: z.string(),
  docType: z.string(),
  docNumber: z.string(),
  description: z.string(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string(),
});
export type StatementEntry = z.infer<typeof statementEntrySchema>;

export const partyStatementResponseSchema = z.strictObject({
  legalEntityId: z.string(),
  partyId: z.string(),
  partyName: z.string(),
  from: z.string(),
  to: z.string(),
  openingBalance: z.string(),
  closingBalance: z.string(),
  totalDebit: z.string(),
  totalCredit: z.string(),
  entries: z.array(statementEntrySchema),
});
export type PartyStatementResponse = z.infer<typeof partyStatementResponseSchema>;
