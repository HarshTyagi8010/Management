import { z } from 'zod';
import { hsnSacSchema, UQC_LIST } from './india.js';
import { patchShape } from './patch.js';
import { businessDateSchema, objectIdSchema, quantitySchema, taxRateSchema, unitPriceSchema } from './primitives.js';

const version = z.number().int().min(0);

/** Unit conversion factor: positive decimal string, up to 6 decimal places. */
export const conversionFactorSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimal places')
  .refine((v) => /[1-9]/.test(v), 'The factor must be more than zero');

export const nonNegativeQuantitySchema = quantitySchema.refine((v) => !v.startsWith('-'), 'Must not be negative');

// ----------------------------------------------------------------- units

export const unitInputSchema = z.strictObject({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(z.string().regex(/^[A-Z0-9]{1,8}$/, 'Use up to 8 letters or digits')),
  name: z.string().trim().min(1).max(40),
  /** GST Unit Quantity Code printed on tax documents (GST-19). */
  uqc: z.enum(UQC_LIST),
  /** Decimal places allowed for quantities in this unit. */
  decimals: z.number().int().min(0).max(3),
});
export const unitUpdateSchema = z.strictObject({ ...patchShape(unitInputSchema.omit({ code: true }).shape), version, archived: z.boolean().optional() });
export const unitSchema = z.strictObject({
  id: objectIdSchema,
  code: z.string(),
  name: z.string(),
  uqc: z.enum(UQC_LIST),
  decimals: z.number().int(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type Unit = z.infer<typeof unitSchema>;

/** Units every new business starts with (code, name, UQC, decimals). Mappings only — no tax content. */
export const DEFAULT_UNITS: Array<[string, string, (typeof UQC_LIST)[number], number]> = [
  ['NOS', 'Numbers', 'NOS', 0],
  ['PCS', 'Pieces', 'PCS', 0],
  ['BOX', 'Box', 'BOX', 0],
  ['SET', 'Set', 'SET', 0],
  ['PAC', 'Pack', 'PAC', 0],
  ['DOZ', 'Dozen', 'DOZ', 0],
  ['KG', 'Kilogram', 'KGS', 3],
  ['G', 'Gram', 'GMS', 0],
  ['L', 'Litre', 'LTR', 3],
  ['ML', 'Millilitre', 'MLT', 0],
  ['M', 'Metre', 'MTR', 2],
  ['SQM', 'Square metre', 'SQM', 2],
  ['HRS', 'Hours (services)', 'OTH', 2],
  ['UNT', 'Units', 'UNT', 0],
];

// ------------------------------------------------------------ categories

export const categoryInputSchema = z.strictObject({ name: z.string().trim().min(1).max(60) });
export const categoryUpdateSchema = z.strictObject({ ...patchShape(categoryInputSchema.shape), version, archived: z.boolean().optional() });
export const categorySchema = z.strictObject({ id: objectIdSchema, name: z.string(), itemCount: z.number().int(), archived: z.boolean(), version: z.number().int() });
export type Category = z.infer<typeof categorySchema>;

// ------------------------------------------------------- tax classes/rates

export const TAX_TREATMENTS = ['taxable', 'exempt', 'nil_rated', 'non_gst'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];
export const TAX_TREATMENT_LABELS: Record<TaxTreatment, string> = {
  taxable: 'Taxable',
  exempt: 'Exempt',
  nil_rated: 'Nil rated',
  non_gst: 'Non-GST supply',
};

export const taxClassInputSchema = z.strictObject({
  name: z.string().trim().min(2).max(60),
  kind: z.enum(['goods', 'service']),
  treatment: z.enum(TAX_TREATMENTS),
  /** Reverse charge applies only to notified categories; set explicitly (GST-13). */
  reverseCharge: z.boolean().default(false),
  description: z.string().trim().max(300).default(''),
});
export const taxClassUpdateSchema = z.strictObject({ ...patchShape(taxClassInputSchema.shape), version, archived: z.boolean().optional() });

export const rateScheduleInputSchema = z
  .strictObject({
    effectiveFrom: businessDateSchema,
    effectiveTo: businessDateSchema.nullable().default(null),
    /** Total GST rate in percent (IGST; CGST and SGST are half each). */
    gstRate: taxRateSchema,
    /** Optional compensation cess, ad valorem percent (GST-12: verify applicability). */
    cessRate: taxRateSchema.nullable().default(null),
    /** Who checked the rate and against what (notification number, circular, adviser). Required: no unsourced rates. */
    sourceReference: z.string().trim().min(5, 'Say where this rate comes from (for example the notification number)').max(300),
  })
  .refine((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom, { path: ['effectiveTo'], message: 'End date must be on or after the start date' })
  // Compared as text (no floating point): 0–100 with up to 4 decimals.
  .refine((r) => /^(\d{1,2}(\.\d{1,4})?|100(\.0{1,4})?)$/.test(r.gstRate), { path: ['gstRate'], message: 'A GST rate is between 0 and 100 percent' });

export const rateScheduleSchema = z.strictObject({
  id: objectIdSchema,
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  gstRate: z.string(),
  cessRate: z.string().nullable(),
  sourceReference: z.string(),
  verifiedBy: z.string(),
  verifiedAt: z.iso.datetime(),
});
export type RateSchedule = z.infer<typeof rateScheduleSchema>;

export const taxClassSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  kind: z.enum(['goods', 'service']),
  treatment: z.enum(TAX_TREATMENTS),
  reverseCharge: z.boolean(),
  description: z.string(),
  schedules: z.array(rateScheduleSchema),
  /** Rate on today’s date (IST), or null if no schedule covers today. */
  currentRate: z.string().nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type TaxClass = z.infer<typeof taxClassSchema>;

// ----------------------------------------------------------------- items

export const ITEM_TYPES = ['stock', 'non_stock', 'service'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
export const ITEM_TYPE_LABELS: Record<ItemType, string> = { stock: 'Stock goods', non_stock: 'Non-stock goods', service: 'Service' };

export const skuSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z0-9][A-Z0-9._/-]{0,39}$/, 'Use letters, digits and . _ / - (up to 40)'));

const altUnitsSchema = z
  .array(z.strictObject({ unitId: objectIdSchema, factor: conversionFactorSchema }))
  .max(5)
  .refine((list) => new Set(list.map((u) => u.unitId)).size === list.length, 'Each alternate unit only once');

export const itemInputSchema = z.strictObject({
  sku: skuSchema,
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1000).default(''),
  type: z.enum(ITEM_TYPES),
  categoryId: objectIdSchema.nullable().default(null),
  baseUnitId: objectIdSchema,
  /** 1 alternate unit = factor × base unit (e.g. 1 BOX = 12 PCS). */
  altUnits: altUnitsSchema.default([]),
  hsnSac: hsnSacSchema,
  taxClassId: objectIdSchema,
  /** Prices need price.edit; leave null when unknown. */
  salePrice: unitPriceSchema.nullable().default(null),
  purchasePrice: unitPriceSchema.nullable().default(null),
  reorderLevel: nonNegativeQuantitySchema.nullable().default(null),
});

export const itemUpdateSchema = z.strictObject({ ...patchShape(itemInputSchema.omit({ sku: true }).shape), version, archived: z.boolean().optional() });

export const itemSchema = z.strictObject({
  id: objectIdSchema,
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(ITEM_TYPES),
  categoryId: objectIdSchema.nullable(),
  categoryName: z.string().nullable(),
  baseUnitId: objectIdSchema,
  baseUnitCode: z.string(),
  altUnits: z.array(z.strictObject({ unitId: objectIdSchema, unitCode: z.string(), factor: z.string() })),
  hsnSac: z.string(),
  taxClassId: objectIdSchema,
  taxClassName: z.string(),
  salePrice: z.string().nullable(),
  /** Omitted unless the caller has price.view_cost (FR-RBAC-04). */
  purchasePrice: z.string().nullable().optional(),
  reorderLevel: z.string().nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type Item = z.infer<typeof itemSchema>;

export const itemListQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  type: z.enum(ITEM_TYPES).optional(),
  categoryId: objectIdSchema.optional(),
  archived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

