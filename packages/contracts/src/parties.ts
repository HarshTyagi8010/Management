import { z } from 'zod';
import { gstinSchema, panSchema, phoneSchema } from './india.js';
import { addressSchema } from './organization.js';
import { patchShape } from './patch.js';
import { businessDateSchema, nonNegativeMoneySchema, objectIdSchema } from './primitives.js';

const version = z.number().int().min(0);
const shortId = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);

export const partyAddressInputSchema = addressSchema.extend({
  /** Client-chosen id so GSTINs can point at an address in the same request. */
  id: shortId,
  label: z.string().trim().max(40).default(''),
  isBilling: z.boolean().default(false),
  isShipping: z.boolean().default(false),
});

export const partyContactInputSchema = z.strictObject({
  id: shortId,
  name: z.string().trim().min(1).max(80),
  designation: z.string().trim().max(60).default(''),
  phone: z.union([z.literal(''), phoneSchema]).default(''),
  email: z.string().trim().max(254).pipe(z.union([z.literal(''), z.email()])).default(''),
});

export const partyGstinInputSchema = z.strictObject({
  gstin: gstinSchema,
  /** Address (by id) that this registration bills from or to. */
  addressId: shortId.nullable().default(null),
});

const partyFields = {
  name: z.string().trim().min(1, 'Enter a name').max(160),
  legalName: z.string().trim().max(160).default(''),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
  pan: z.union([z.literal(''), panSchema]).default(''),
  gstins: z.array(partyGstinInputSchema).max(40).default([]),
  addresses: z.array(partyAddressInputSchema).max(20).default([]),
  contacts: z.array(partyContactInputSchema).max(20).default([]),
  creditLimit: nonNegativeMoneySchema.nullable().default(null),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
  /** Save even though the duplicate check found matching GSTIN, PAN or phone (FR-PTY-02). */
  confirmDuplicates: z.boolean().default(false),
};

function partyRules<T extends z.ZodType<{ isCustomer?: boolean | undefined; isSupplier?: boolean | undefined; pan?: string | undefined; gstins?: Array<{ gstin: string; addressId: string | null }> | undefined; addresses?: Array<{ id: string }> | undefined }>>(schema: T) {
  return schema.superRefine((p, ctx) => {
    if (p.isCustomer === false && p.isSupplier === false) ctx.addIssue({ code: 'custom', path: ['isCustomer'], message: 'A party must be a customer, a supplier or both' });
    const gstins = p.gstins ?? [];
    if (new Set(gstins.map((g) => g.gstin)).size !== gstins.length) ctx.addIssue({ code: 'custom', path: ['gstins'], message: 'Each GSTIN only once' });
    gstins.forEach((g, i) => {
      if (p.pan && g.gstin.slice(2, 12) !== p.pan) ctx.addIssue({ code: 'custom', path: ['gstins', i, 'gstin'], message: 'This GSTIN belongs to a different PAN' });
      if (g.addressId && !(p.addresses ?? []).some((a) => a.id === g.addressId)) ctx.addIssue({ code: 'custom', path: ['gstins', i, 'addressId'], message: 'Unknown address' });
    });
    const ids = (p.addresses ?? []).map((a) => a.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: ['addresses'], message: 'Duplicate address id' });
  });
}

export const partyInputSchema = partyRules(z.strictObject(partyFields));
export const partyUpdateSchema = partyRules(z.strictObject({ ...patchShape(partyFields), version, confirmDuplicates: z.boolean().default(false), archived: z.boolean().optional() }));

export const partyAddressSchema = partyAddressInputSchema;
export const partySchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  legalName: z.string(),
  isCustomer: z.boolean(),
  isSupplier: z.boolean(),
  addresses: z.array(partyAddressSchema),
  // The fields below are omitted for callers with only party.view_basic (name and address).
  pan: z.string().optional(),
  gstins: z.array(z.strictObject({ gstin: z.string(), stateCode: z.string(), addressId: z.string().nullable() })).optional(),
  contacts: z.array(partyContactInputSchema).optional(),
  creditLimit: z.string().nullable().optional(),
  paymentTermsDays: z.number().int().nullable().optional(),
  tags: z.array(z.string()).optional(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type Party = z.infer<typeof partySchema>;

export const partyListQuerySchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['customer', 'supplier']).optional(),
  archived: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- CRM

export const noteInputSchema = z.strictObject({ body: z.string().trim().min(1).max(4000) });

export const taskInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  details: z.string().trim().max(2000).default(''),
  dueDate: businessDateSchema,
  /** A member's user id; defaults to the creator. */
  assigneeId: objectIdSchema.nullable().default(null),
});

export const taskUpdateSchema = z.strictObject({
  version,
  title: z.string().trim().min(1).max(160).optional(),
  details: z.string().trim().max(2000).optional(),
  dueDate: businessDateSchema.optional(),
  assigneeId: objectIdSchema.optional(),
  status: z.enum(['open', 'done', 'cancelled']).optional(),
});

export const crmTaskSchema = z.strictObject({
  id: objectIdSchema,
  partyId: objectIdSchema,
  partyName: z.string(),
  title: z.string(),
  details: z.string(),
  dueDate: z.string(),
  status: z.enum(['open', 'done', 'cancelled']),
  assignee: z.strictObject({ id: objectIdSchema, name: z.string() }),
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
});
export type CrmTask = z.infer<typeof crmTaskSchema>;

export const crmNoteSchema = z.strictObject({
  id: objectIdSchema,
  partyId: objectIdSchema,
  body: z.string(),
  author: z.string(),
  createdAt: z.iso.datetime(),
});
export type CrmNote = z.infer<typeof crmNoteSchema>;

export const timelineEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('note'), at: z.iso.datetime(), note: crmNoteSchema }),
  z.strictObject({ kind: z.literal('task'), at: z.iso.datetime(), task: crmTaskSchema }),
]);
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const taskListQuerySchema = z.strictObject({
  assignee: z.enum(['me', 'anyone']).default('me'),
  status: z.enum(['open', 'done', 'cancelled']).default('open'),
  partyId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
