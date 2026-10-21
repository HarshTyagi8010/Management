import { z } from 'zod';
import { stateCodeSchema } from './india.js';
import { businessDateSchema, nonNegativeMoneySchema, objectIdSchema, quantitySchema, taxRateSchema, unitPriceSchema } from './primitives.js';

/**
 * Financial engine (Phase 6): calculation preview, chart of accounts, journals,
 * period locks, integrity checks and generated documents.
 */

// ------------------------------------------------------------ calculation

const positiveQuantity = quantitySchema.refine((v) => !v.startsWith('-') && /[1-9]/.test(v), 'Enter a quantity more than zero');

export const lineDiscountSchema = z
  .discriminatedUnion('type', [z.strictObject({ type: z.literal('percent'), value: taxRateSchema }), z.strictObject({ type: z.literal('amount'), value: nonNegativeMoneySchema })])
  .nullable();

export const calcPreviewRequestSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  /** The seller's GSTIN (place of business); decides intra- or inter-state with the place of supply. */
  gstRegistrationId: objectIdSchema,
  partyId: objectIdSchema.nullable().default(null),
  docDate: businessDateSchema,
  /** State code of the place of supply (GST-10: chosen explicitly; legal review C-01). */
  placeOfSupply: stateCodeSchema,
  documentDiscount: nonNegativeMoneySchema.default('0'),
  lines: z
    .array(z.strictObject({ itemId: objectIdSchema, qty: positiveQuantity, unitPrice: unitPriceSchema, discount: lineDiscountSchema.default(null) }))
    .min(1, 'Add at least one line')
    .max(200),
});
export type CalcPreviewRequest = z.infer<typeof calcPreviewRequestSchema>;

const taxAmounts = { taxable: z.string(), cgst: z.string(), sgst: z.string(), utgst: z.string(), igst: z.string(), cess: z.string() };

export const partySnapshotSchema = z.strictObject({
  partyId: objectIdSchema,
  name: z.string(),
  legalName: z.string(),
  gstin: z.string().nullable(),
  stateCode: z.string().nullable(),
});

export const sellerSnapshotSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  legalName: z.string(),
  tradeName: z.string(),
  gstin: z.string(),
  stateCode: z.string(),
  registrationType: z.enum(['regular', 'composition']),
});

export const calcPreviewSchema = z.strictObject({
  calcVersion: z.string(),
  /** Bills of supply for composition taxpayers and documents with no taxable line; tax invoices otherwise (GST-14). */
  documentKind: z.enum(['tax_invoice', 'bill_of_supply']),
  supply: z.enum(['intra', 'inter']),
  placeOfSupply: z.string(),
  seller: sellerSnapshotSchema,
  buyer: partySnapshotSchema.nullable(),
  lines: z.array(
    z.strictObject({
      itemId: objectIdSchema,
      item: z.strictObject({ sku: z.string(), name: z.string(), type: z.enum(['stock', 'non_stock', 'service']), hsnSac: z.string(), unitCode: z.string(), uqc: z.string() }),
      qty: z.string(),
      unitPrice: z.string(),
      taxRate: z.string().nullable(),
      cessRate: z.string().nullable(),
      gross: z.string(),
      discount: z.string(),
      net: z.string(),
      documentDiscount: z.string(),
      ...taxAmounts,
      taxCharged: z.string(),
      total: z.string(),
      reverseCharge: z.boolean(),
    }),
  ),
  totals: z.strictObject({ ...taxAmounts, gross: z.string(), discount: z.string(), taxCharged: z.string(), reverseChargeTax: z.string(), subtotal: z.string(), roundOff: z.string(), grand: z.string() }),
  hsnSummary: z.array(z.strictObject({ ...taxAmounts, hsnSac: z.string(), rate: z.string().nullable(), reverseCharge: z.boolean() })),
  /** Things to check before issuing (e.g. HSN digits below the turnover band's minimum). */
  warnings: z.array(z.string()),
});
export type CalcPreview = z.infer<typeof calcPreviewSchema>;

// --------------------------------------------------------------- accounts

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * System chart of accounts created for every business entity (ADR-011).
 * Internal books for ledgers and reconciliation, not statutory statements.
 */
export const SYSTEM_ACCOUNTS = [
  ['1100', 'Cash', 'asset'],
  ['1110', 'Bank', 'asset'],
  ['1200', 'Trade receivables', 'asset'],
  ['1300', 'Inventory', 'asset'],
  ['1410', 'Input CGST', 'asset'],
  ['1411', 'Input SGST/UTGST', 'asset'],
  ['1412', 'Input IGST', 'asset'],
  ['1413', 'Input cess', 'asset'],
  ['2100', 'Trade payables', 'liability'],
  ['2210', 'Output CGST', 'liability'],
  ['2211', 'Output SGST/UTGST', 'liability'],
  ['2212', 'Output IGST', 'liability'],
  ['2213', 'Output cess', 'liability'],
  ['2300', 'Customer advances', 'liability'],
  ['3100', 'Opening balances', 'equity'],
  ['4100', 'Sales', 'income'],
  ['4900', 'Rounding', 'income'],
  ['5100', 'Purchases (non-stock)', 'expense'],
  ['5200', 'Cost of goods sold', 'expense'],
  ['5300', 'Inventory adjustments', 'expense'],
  ['5400', 'Expenses', 'expense'],
] as const satisfies ReadonlyArray<readonly [string, string, AccountType]>;
export type SystemAccountCode = (typeof SYSTEM_ACCOUNTS)[number][0];

export const accountSchema = z.strictObject({
  id: objectIdSchema,
  legalEntityId: objectIdSchema,
  code: z.string(),
  name: z.string(),
  type: z.enum(ACCOUNT_TYPES),
  system: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;

export const JOURNAL_SOURCE_TYPES = [
  'stock_adjustment',
  'stock_count',
  'stock_transfer',
  'dispatch',
  'sales_invoice',
  'supplier_bill',
  'payment',
  'refund',
  'expense',
  'credit_note',
  'debit_note',
] as const;

export const journalSchema = z.strictObject({
  id: objectIdSchema,
  legalEntityId: objectIdSchema,
  docDate: z.string(),
  sourceType: z.enum(JOURNAL_SOURCE_TYPES),
  sourceId: objectIdSchema,
  sourceNumber: z.string(),
  narration: z.string(),
  lines: z.array(z.strictObject({ accountCode: z.string(), accountName: z.string(), debit: z.string(), credit: z.string() })),
  totalDebit: z.string(),
  totalCredit: z.string(),
  reversal: z.boolean(),
  reversedJournalId: objectIdSchema.nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type Journal = z.infer<typeof journalSchema>;

export const journalListQuerySchema = z.strictObject({
  legalEntityId: objectIdSchema.optional(),
  sourceType: z.enum(JOURNAL_SOURCE_TYPES).optional(),
  sourceId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: objectIdSchema.optional(),
});

export const trialBalanceSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  asOf: z.string(),
  rows: z.array(z.strictObject({ code: z.string(), name: z.string(), type: z.enum(ACCOUNT_TYPES), debit: z.string(), credit: z.string() })),
  totalDebit: z.string(),
  totalCredit: z.string(),
});
export type TrialBalance = z.infer<typeof trialBalanceSchema>;

// ----------------------------------------------------------- period locks

export const periodLockUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  /** Postings dated on or before this date are refused; null removes the lock. */
  lockDate: businessDateSchema.nullable(),
  reason: z.string().trim().min(5, 'Say why (for the audit log)').max(300),
});

// ------------------------------------------------------- integrity checks

export const INTEGRITY_CHECK_KINDS = ['stock', 'journals'] as const;
export const integrityCheckSchema = z.strictObject({
  kind: z.enum(INTEGRITY_CHECK_KINDS),
  checkedAt: z.iso.datetime(),
  ok: z.boolean(),
  issueCount: z.number().int(),
  /** Short, non-sensitive description of what was found. */
  summary: z.string(),
});
export type IntegrityCheck = z.infer<typeof integrityCheckSchema>;

// ------------------------------------------------------ generated documents

export const ARTIFACT_STATUSES = ['pending', 'ready', 'failed'] as const;
export const documentArtifactSchema = z.strictObject({
  status: z.enum(ARTIFACT_STATUSES),
  templateVersion: z.string(),
  /** Set when ready. */
  sizeBytes: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
});
export type DocumentArtifact = z.infer<typeof documentArtifactSchema>;
