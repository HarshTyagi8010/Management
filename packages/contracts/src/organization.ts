import { z } from 'zod';
import { gstinSchema, ifscSchema, panSchema, pincodeSchema, shortFinancialYear, stateCodeSchema, TURNOVER_BANDS } from './india.js';
import { patchShape } from './patch.js';
import { objectIdSchema } from './primitives.js';

export const addressSchema = z.strictObject({
  line1: z.string().trim().min(1, 'Enter the address').max(120),
  line2: z.string().trim().max(120).default(''),
  city: z.string().trim().min(1, 'Enter the city or town').max(60),
  district: z.string().trim().max(60).default(''),
  stateCode: stateCodeSchema,
  pincode: pincodeSchema,
});
export type Address = z.infer<typeof addressSchema>;

export const CONSTITUTIONS = ['proprietorship', 'partnership', 'llp', 'private_limited', 'public_limited', 'huf', 'trust', 'society', 'government', 'other'] as const;
export const CONSTITUTION_LABELS: Record<(typeof CONSTITUTIONS)[number], string> = {
  proprietorship: 'Proprietorship',
  partnership: 'Partnership firm',
  llp: 'Limited liability partnership',
  private_limited: 'Private limited company',
  public_limited: 'Public limited company',
  huf: 'Hindu undivided family',
  trust: 'Trust',
  society: 'Society',
  government: 'Government body',
  other: 'Other',
};

export const workflowSettingsSchema = z.strictObject({
  /** When stock leaves: on dispatch (delivery challan) or on invoice (ADR-010). */
  stockOutPoint: z.enum(['dispatch', 'invoice']),
  /** When stock arrives: on goods receipt or on supplier bill. */
  stockInPoint: z.enum(['goods_receipt', 'supplier_bill']),
  allowNegativeStock: z.boolean(),
  /** Round document totals to the nearest rupee (round-off line, financial-policy R4). */
  roundOffTotal: z.boolean(),
});
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const DEFAULT_WORKFLOW: WorkflowSettings = { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true };

export const bankAccountInputSchema = z.strictObject({
  bankName: z.string().trim().min(2).max(80),
  accountName: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().regex(/^[0-9]{6,18}$/, 'An account number has 6 to 18 digits'),
  ifsc: ifscSchema,
  branch: z.string().trim().max(80).default(''),
  /** UPI id printed on documents for payment (e.g. business@bank); not a payment integration. */
  upiId: z
    .string()
    .trim()
    .max(80)
    .regex(/^$|^[a-zA-Z0-9._-]{2,64}@[a-zA-Z]{2,32}$/, 'A UPI id looks like name@bank')
    .default(''),
  isDefault: z.boolean().default(false),
});

export const legalEntityInputSchema = z.strictObject({
  legalName: z.string().trim().min(2).max(120),
  tradeName: z.string().trim().max(120).default(''),
  pan: panSchema,
  constitution: z.enum(CONSTITUTIONS),
  address: addressSchema,
  email: z.string().trim().max(254).pipe(z.union([z.literal(''), z.email()])).default(''),
  phone: z.string().trim().max(20).default(''),
  turnoverBand: z.enum(TURNOVER_BANDS),
});

export const legalEntityUpdateSchema = z.strictObject({ ...patchShape(legalEntityInputSchema.shape), version: z.number().int().min(0) });

export const workflowUpdateSchema = workflowSettingsSchema.extend({ version: z.number().int().min(0) }).strict();

export const bankAccountsUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  bankAccounts: z
    .array(bankAccountInputSchema)
    .max(10)
    .refine((list) => list.filter((b) => b.isDefault).length <= 1, 'Only one account can be the default'),
});

export const bankAccountSchema = bankAccountInputSchema.extend({ id: z.string() });

export const legalEntitySchema = z.strictObject({
  id: objectIdSchema,
  legalName: z.string(),
  tradeName: z.string(),
  pan: z.string(),
  constitution: z.enum(CONSTITUTIONS),
  address: addressSchema,
  email: z.string(),
  phone: z.string(),
  /** April–March (GST financial year); fixed in this version. */
  fyStartMonth: z.literal(4),
  turnoverBand: z.enum(TURNOVER_BANDS),
  workflow: workflowSettingsSchema,
  /** Postings dated on or before this date are refused (FR-CO-05). */
  periodLockDate: z.string().nullable(),
  /** Present only for callers with settings.view or settings.company. */
  bankAccounts: z.array(bankAccountSchema).optional(),
  /** Printed on new documents (FR-CO-01). */
  logo: z.strictObject({ contentType: z.string(), sizeBytes: z.number().int(), width: z.number().int(), height: z.number().int() }).nullable(),
  registrationCount: z.number().int(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type LegalEntity = z.infer<typeof legalEntitySchema>;

export const REGISTRATION_TYPES = ['regular', 'composition'] as const;

export const gstRegistrationInputSchema = z
  .strictObject({
    gstin: gstinSchema,
    registrationType: z.enum(REGISTRATION_TYPES),
    effectiveFrom: z.iso.date(),
    effectiveTo: z.iso.date().nullable().default(null),
    /** Principal place of business for this registration; its state must match the GSTIN. */
    address: addressSchema,
    label: z.string().trim().max(60).default(''),
  })
  .refine((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom, { path: ['effectiveTo'], message: 'End date must be on or after the start date' })
  .refine((r) => r.address.stateCode === r.gstin.slice(0, 2), { path: ['address', 'stateCode'], message: 'The address must be in the GSTIN’s state' });

export const gstRegistrationUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  registrationType: z.enum(REGISTRATION_TYPES).optional(),
  effectiveTo: z.iso.date().nullable().optional(),
  address: addressSchema.optional(),
  label: z.string().trim().max(60).optional(),
});

export const gstRegistrationSchema = z.strictObject({
  id: objectIdSchema,
  legalEntityId: objectIdSchema,
  gstin: z.string(),
  stateCode: z.string(),
  registrationType: z.enum(REGISTRATION_TYPES),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  address: addressSchema,
  label: z.string(),
  version: z.number().int(),
});
export type GstRegistration = z.infer<typeof gstRegistrationSchema>;

/** Document types and the scope their numbering belongs to (GST documents number per registration). */
export const DOCUMENT_TYPES = {
  tax_invoice: { label: 'Tax invoice', scope: 'registration' },
  bill_of_supply: { label: 'Bill of supply', scope: 'registration' },
  credit_note: { label: 'Credit note', scope: 'registration' },
  debit_note: { label: 'Debit note', scope: 'registration' },
  delivery_challan: { label: 'Delivery challan', scope: 'registration' },
  quotation: { label: 'Quotation', scope: 'legal_entity' },
  proforma_invoice: { label: 'Proforma invoice', scope: 'legal_entity' },
  sales_order: { label: 'Sales order', scope: 'legal_entity' },
  purchase_order: { label: 'Purchase order', scope: 'legal_entity' },
  goods_receipt: { label: 'Goods receipt', scope: 'legal_entity' },
  supplier_bill: { label: 'Supplier bill', scope: 'legal_entity' },
  receipt: { label: 'Receipt', scope: 'legal_entity' },
  payment: { label: 'Payment', scope: 'legal_entity' },
} as const satisfies Record<string, { label: string; scope: 'registration' | 'legal_entity' }>;
export type DocumentType = keyof typeof DOCUMENT_TYPES;
export const DOCUMENT_TYPE_LIST = Object.keys(DOCUMENT_TYPES) as [DocumentType, ...DocumentType[]];

/** Rule 46(b): at most 16 characters (GST-01). */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;
export const FY_TOKEN = '{FY}';

/** Prefix: letters, digits, "/" and "-", optionally containing {FY} (renders as e.g. 26-27). */
export const seriesPrefixSchema = z
  .string()
  .trim()
  .max(14)
  .regex(/^([A-Za-z0-9/-]|\{FY\})*$/, 'Use letters, digits, “/”, “-” and {FY} only');

export interface SeriesFormat {
  prefix: string;
  padding: number;
}

/** Renders a document number, e.g. ({prefix:"INV/{FY}/", padding:4}, 12, "2026-27") → "INV/26-27/0012". */
export function formatDocumentNumber(format: SeriesFormat, number: number, fy: string): string {
  return format.prefix.split(FY_TOKEN).join(shortFinancialYear(fy)) + String(number).padStart(format.padding, '0');
}

/** The rendered prefix length is the same for every financial year ("26-27" is always 5 characters). */
export const renderedPrefixLength = (prefix: string) => prefix.split(FY_TOKEN).join('00-00').length;

/** Largest number that still fits in 16 characters. */
export function seriesCapacity(format: SeriesFormat): number {
  const digits = MAX_DOCUMENT_NUMBER_LENGTH - renderedPrefixLength(format.prefix);
  return digits < format.padding ? 0 : 10 ** digits - 1;
}

export const seriesInputSchema = z
  .strictObject({
    legalEntityId: objectIdSchema,
    /** Required for registration-scoped document types. */
    gstRegistrationId: objectIdSchema.nullable().default(null),
    docType: z.enum(DOCUMENT_TYPE_LIST),
    name: z.string().trim().min(2).max(60),
    prefix: seriesPrefixSchema,
    padding: z.number().int().min(1).max(10),
    /** First number in each financial year (usually 1; higher when continuing numbering from another system). */
    startNumber: z.number().int().min(1).max(99_999_999).default(1),
    isDefault: z.boolean().default(false),
  })
  .superRefine((s, ctx) => {
    const capacity = seriesCapacity(s);
    if (capacity === 0) ctx.addIssue({ code: 'custom', path: ['prefix'], message: `Numbers must fit in ${MAX_DOCUMENT_NUMBER_LENGTH} characters; shorten the prefix or padding` });
    else if (s.startNumber > capacity) ctx.addIssue({ code: 'custom', path: ['startNumber'], message: 'The start number does not fit in 16 characters with this prefix' });
    if (DOCUMENT_TYPES[s.docType].scope === 'registration' && !s.gstRegistrationId) {
      ctx.addIssue({ code: 'custom', path: ['gstRegistrationId'], message: 'Choose the GST registration this series belongs to' });
    }
    if (DOCUMENT_TYPES[s.docType].scope === 'legal_entity' && s.gstRegistrationId) {
      ctx.addIssue({ code: 'custom', path: ['gstRegistrationId'], message: 'This document type is numbered per business, not per registration' });
    }
  });

export const seriesUpdateSchema = z.strictObject({
  version: z.number().int().min(0),
  name: z.string().trim().min(2).max(60).optional(),
  prefix: seriesPrefixSchema.optional(),
  padding: z.number().int().min(1).max(10).optional(),
  startNumber: z.number().int().min(1).max(99_999_999).optional(),
  isDefault: z.boolean().optional(),
  active: z.boolean().optional(),
});

export const documentSeriesSchema = z.strictObject({
  id: objectIdSchema,
  legalEntityId: objectIdSchema,
  gstRegistrationId: objectIdSchema.nullable(),
  docType: z.enum(DOCUMENT_TYPE_LIST),
  name: z.string(),
  prefix: z.string(),
  padding: z.number().int(),
  startNumber: z.number().int(),
  isDefault: z.boolean(),
  active: z.boolean(),
  /** Format fields lock once any number has been issued from the series (no renumbering). */
  locked: z.boolean(),
  example: z.string(),
  capacity: z.number().int(),
  version: z.number().int(),
});
export type DocumentSeries = z.infer<typeof documentSeriesSchema>;
