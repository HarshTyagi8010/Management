import { z } from 'zod';
import { businessDateSchema, moneySchema, objectIdSchema } from './primitives.js';

/**
 * Compliance & Statutory Preparation Contracts (Batch C)
 * Notice: Preparation only — not filed. No direct GSTN portal filing or simulated upload.
 */

export const COMPLIANCE_STATUS = 'PREPARATION_ONLY_NOT_FILED' as const;

// ------------------------------------------------------------ Outward Register
export const outwardSupplyCategorySchema = z.enum([
  'B2B',       // Table 4A: Regular registered recipients with valid GSTIN
  'B2CL',      // Table 5: Large inter-state unregistered supplies (> ₹1L on or after 2024-08-01 per Notif 12/2024-CT, > ₹2.5L before)
  'B2CS',      // Table 7: Other unregistered supplies (all intra-state, inter-state <= threshold, and unregistered credit notes against B2CS)
  'NIL_RATED', // Table 8: Supplies with statutory 0% tariff
  'EXEMPTED',  // Table 8: Supplies exempt by notification under s.11 / s.6
  'NON_GST',   // Table 8 / 3.1(e): Outside GST scope (petroleum, alcohol)
  'CDNR',      // Table 9B: Credit/Debit notes to registered recipients
  'CDNUR',     // Table 9B: Credit/Debit notes to unregistered recipients for B2CL supplies only
]);
export type OutwardSupplyCategory = z.infer<typeof outwardSupplyCategoryCategorySchema>;
const outwardSupplyCategoryCategorySchema = outwardSupplyCategorySchema;

export const outwardExceptionReasonSchema = z.enum([
  'AMBIGUOUS_ZERO_RATE',
  'MISSING_BUYER_STATE',
  'MISSING_RECIPIENT_GSTIN',
  'UNVERIFIED_TAX_CLASS',
  'INVALID_TURNOVER_HSN',
  'UNSUPPORTED_RCM_OUTWARD',
  'OTHER_UNCLASSIFIED',
]);
export type OutwardExceptionReason = z.infer<typeof outwardExceptionReasonSchema>;

export const outwardSupplyLineSchema = z.strictObject({
  documentId: objectIdSchema,
  documentNumber: z.string(),
  documentKind: z.string(),
  docDate: businessDateSchema,
  accountingDate: businessDateSchema,
  partyId: objectIdSchema.nullable(),
  partyName: z.string(),
  recipientGstin: z.string().nullable(),
  placeOfSupply: z.string(),
  supplyType: z.enum(['intra', 'inter']),
  category: outwardSupplyCategorySchema,
  taxableValue: moneySchema,
  cgst: moneySchema,
  sgst: moneySchema,
  utgst: moneySchema,
  igst: moneySchema,
  cess: moneySchema,
  totalTax: moneySchema,
  grandTotal: moneySchema,
  status: z.string(),
  isReverseCharge: z.boolean(),
});
export type OutwardSupplyLine = z.infer<typeof outwardSupplyLineSchema>;

export const outwardExceptionItemSchema = z.strictObject({
  documentId: objectIdSchema,
  documentNumber: z.string(),
  docDate: businessDateSchema,
  partyName: z.string(),
  reasonCode: outwardExceptionReasonSchema,
  message: z.string(),
  taxableValue: moneySchema,
  totalTax: moneySchema,
  grandTotal: moneySchema,
});
export type OutwardExceptionItem = z.infer<typeof outwardExceptionItemSchema>;

export const outwardSupplySummarySchema = z.strictObject({
  category: outwardSupplyCategorySchema,
  documentCount: z.number().int(),
  taxableValue: moneySchema,
  cgst: moneySchema,
  sgst: moneySchema,
  utgst: moneySchema,
  igst: moneySchema,
  cess: moneySchema,
  totalTax: moneySchema,
  grandTotal: moneySchema,
});
export type OutwardSupplySummary = z.infer<typeof outwardSupplySummarySchema>;

export const outwardRegisterResponseSchema = z.strictObject({
  title: z.string(),
  disclaimer: z.string(),
  status: z.literal(COMPLIANCE_STATUS),
  generatedAt: z.string(),
  legalEntityId: objectIdSchema,
  legalEntityName: z.string(),
  legalEntityPan: z.string(),
  gstin: z.string().nullable(),
  period: z.strictObject({
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  }),
  summaries: z.array(outwardSupplySummarySchema),
  lines: z.array(outwardSupplyLineSchema),
  exceptions: z.array(outwardExceptionItemSchema),
  reconciliation: z.strictObject({
    totalSourceDocumentsCount: z.number().int(),
    totalSourceTaxableValue: moneySchema,
    totalSourceTaxAmount: moneySchema,
    totalSourceGrandTotal: moneySchema,
    classifiedTaxableValue: moneySchema,
    classifiedTaxAmount: moneySchema,
    exceptionsTaxableValue: moneySchema,
    exceptionsTaxAmount: moneySchema,
    differenceTaxableValue: moneySchema,
    differenceTaxAmount: moneySchema,
    isPopulationReconciled: z.boolean(),
  }),
});
export type OutwardRegisterResponse = z.infer<typeof outwardRegisterResponseSchema>;

// ------------------------------------------------------------ Purchase Register / ITC Review
export const itcGstr3bCategorySchema = z.enum([
  'TABLE_4_A_5_ALL_OTHER_ITC',              // Eligible inward supplies (bills & expenses)
  'TABLE_4_B_1_PERMANENT_REVERSAL_17_5',     // Blocked credits reversed permanently
  'TABLE_4_B_2_TEMPORARY_REVERSAL_OTHERS',   // Verified temporary reversals (where evidence exists)
  'INELIGIBLE_GROSS_EXPENSED',              // Ineligible inward supplies debited to 5100/1300, not claimed
  'REVIEW_REQUIRED',                        // Commercial return memos / unverified supplier adjustments requiring GSTR-2B review
]);
export type ItcGstr3bCategory = z.infer<typeof itcGstr3bCategorySchema>;

export const purchaseRegisterLineSchema = z.strictObject({
  docId: objectIdSchema,
  docNumber: z.string(),
  docType: z.enum(['supplier_bill', 'direct_expense', 'purchase_return_debit_note', 'commercial_memo']),
  supplierInvoiceNumber: z.string().nullable(),
  supplierInvoiceDate: businessDateSchema.nullable(),
  docDate: businessDateSchema,             // Accounting date
  supplierId: objectIdSchema.nullable(),
  supplierName: z.string(),
  supplierGstin: z.string().nullable(),
  supplierStateCode: z.string().nullable(),
  taxCharged: z.strictObject({
    taxable: moneySchema,
    cgst: moneySchema,
    sgst: moneySchema,
    utgst: moneySchema,
    igst: moneySchema,
    cess: moneySchema,
    totalTax: moneySchema,
  }),
  accountingTreatment: z.enum(['input_tax_control_141x', 'gross_cost_5100_1300']),
  declaredItcEligible: z.boolean(),
  gstr3bCategory: itcGstr3bCategorySchema,
  reviewReason: z.string().nullable(),
  externalStatementMatchStatus: z.literal('not_imported'),
  status: z.string(),
});
export type PurchaseRegisterLine = z.infer<typeof purchaseRegisterLineSchema>;

export const purchaseRegisterResponseSchema = z.strictObject({
  title: z.string(),
  disclaimer: z.string(),
  status: z.literal(COMPLIANCE_STATUS),
  generatedAt: z.string(),
  legalEntityId: objectIdSchema,
  legalEntityName: z.string(),
  gstin: z.string().nullable(),
  period: z.strictObject({
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  }),
  lines: z.array(purchaseRegisterLineSchema),
  totals: z.strictObject({
    totalInwardTaxable: moneySchema,
    totalInwardTaxCharged: moneySchema,
    eligibleTaxable: moneySchema,
    eligibleTaxCharged: moneySchema,
    ineligibleGrossExpensedTax: moneySchema,
    purchaseReturnAccountingReversalTax: moneySchema,
    netEligibleTaxUnderReview: moneySchema,
    reviewRequiredCount: z.number().int(),
  }),
  unsupportedFeatures: z.array(z.string()),
});
export type PurchaseRegisterResponse = z.infer<typeof purchaseRegisterResponseSchema>;

// ------------------------------------------------------------ HSN / SAC Summary
export const hsnSummaryItemSchema = z.strictObject({
  hsnSac: z.string(),
  description: z.string(),
  itemType: z.enum(['stock', 'non_stock', 'service']),
  uqc: z.string(),
  recipientCategory: z.enum(['B2B', 'B2C']),
  rate: z.string().nullable(),
  totalQty: z.string().nullable(),
  totalValue: moneySchema,
  taxableValue: moneySchema,
  cgst: moneySchema,
  sgst: moneySchema,
  utgst: moneySchema,
  igst: moneySchema,
  cess: moneySchema,
  totalTax: moneySchema,
});
export type HsnSummaryItem = z.infer<typeof hsnSummaryItemSchema>;

export const hsnSummaryResponseSchema = z.strictObject({
  title: z.string(),
  disclaimer: z.string(),
  status: z.literal(COMPLIANCE_STATUS),
  generatedAt: z.string(),
  legalEntityId: objectIdSchema,
  period: z.strictObject({
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  }),
  b2bSummary: z.array(hsnSummaryItemSchema),
  b2cSummary: z.array(hsnSummaryItemSchema),
  exceptions: z.array(
    z.strictObject({
      documentNumber: z.string(),
      lineId: z.string(),
      itemName: z.string(),
      reason: z.string(),
    }),
  ),
  totals: z.strictObject({
    totalTaxable: moneySchema,
    totalTax: moneySchema,
    totalValue: moneySchema,
  }),
});
export type HsnSummaryResponse = z.infer<typeof hsnSummaryResponseSchema>;

// ------------------------------------------------------------ Document Summary (Table 13)
export const documentIssuedItemSchema = z.strictObject({
  natureOfDocument: z.string(),
  docType: z.string(),
  seriesPrefix: z.string(),
  fromSerial: z.string(),
  toSerial: z.string(),
  totalIssued: z.number().int(),
  cancelled: z.number().int(),
  netIssued: z.number().int(),
});
export type DocumentIssuedItem = z.infer<typeof documentIssuedItemSchema>;

export const documentSummaryResponseSchema = z.strictObject({
  title: z.string(),
  disclaimer: z.string(),
  status: z.literal(COMPLIANCE_STATUS),
  generatedAt: z.string(),
  legalEntityId: objectIdSchema,
  period: z.strictObject({
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
  }),
  table13Documents: z.array(documentIssuedItemSchema),
  internalExcludedSeries: z.array(
    z.strictObject({
      seriesPrefix: z.string(),
      nature: z.string(),
      exclusionReason: z.string(),
      totalCount: z.number().int(),
    }),
  ),
  unsupportedTable13Categories: z.array(z.string()),
});
export type DocumentSummaryResponse = z.infer<typeof documentSummaryResponseSchema>;

// ------------------------------------------------------------ Period-Close Readiness Checklist
export const checklistSeveritySchema = z.enum(['informational', 'warning', 'blocker']);
export type ChecklistSeverity = z.infer<typeof checklistSeveritySchema>;

export const checklistFindingSchema = z.strictObject({
  code: z.string(),
  category: z.enum(['reconciliation', 'journal_integrity', 'documents', 'inventory', 'payments']),
  severity: checklistSeveritySchema,
  title: z.string(),
  description: z.string(),
  isBlocking: z.boolean(),
  details: z.record(z.string(), z.any()).optional(),
});
export type ChecklistFinding = z.infer<typeof checklistFindingSchema>;

export const periodCloseChecklistResponseSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  periodEndDate: businessDateSchema,
  generatedAt: z.string(),
  canClose: z.boolean(),
  closeMode: z.enum(['reconciled_close', 'administrative_lock']),
  isPastPeriod: z.boolean(),
  coordinationToken: z.string(),
  counts: z.strictObject({
    blockers: z.number().int(),
    warnings: z.number().int(),
    informational: z.number().int(),
  }),
  findings: z.array(checklistFindingSchema),
  reconciliationStatus: z.string(),
  pastPeriodNotice: z.string().nullable(),
});
export type PeriodCloseChecklistResponse = z.infer<typeof periodCloseChecklistResponseSchema>;

export const periodCloseExecuteRequestSchema = z.strictObject({
  legalEntityId: objectIdSchema,
  periodEndDate: businessDateSchema,
  coordinationToken: z.string(),
  mode: z.enum(['reconciled_close', 'administrative_lock']).default('reconciled_close'),
  reason: z.string().min(5, 'Provide a close reason of at least 5 characters'),
  acknowledgeWarnings: z.boolean().default(false),
});
export type PeriodCloseExecuteRequest = z.infer<typeof periodCloseExecuteRequestSchema>;

export const periodCloseExecuteResponseSchema = z.strictObject({
  success: z.boolean(),
  periodLockDate: businessDateSchema,
  closeMode: z.enum(['reconciled_close', 'administrative_lock']),
  message: z.string(),
  closedAt: z.string(),
});
export type PeriodCloseExecuteResponse = z.infer<typeof periodCloseExecuteResponseSchema>;

// ------------------------------------------------------------ Compliance Capability Status
export const complianceCapabilitiesResponseSchema = z.strictObject({
  disclaimer: z.string(),
  status: z.literal(COMPLIANCE_STATUS),
  supportedCapabilities: z.array(
    z.strictObject({
      feature: z.string(),
      description: z.string(),
      scope: z.string(),
    }),
  ),
  unsupportedCapabilities: z.array(
    z.strictObject({
      feature: z.string(),
      reason: z.string(),
      futureConsideration: z.string(),
    }),
  ),
});
export type ComplianceCapabilitiesResponse = z.infer<typeof complianceCapabilitiesResponseSchema>;
