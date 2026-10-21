import { z } from 'zod';
import { emailSchema } from './auth.js';
import { isPermission, PERMISSIONS, SYSTEM_ROLE_KEYS, type Permission } from './permissions.js';
import { objectIdSchema } from './primitives.js';

export const permissionSchema = z.enum(PERMISSIONS);

const permissionListSchema = z
  .array(z.string())
  .max(PERMISSIONS.length)
  .refine((list) => list.every(isPermission), 'Unknown permission')
  .refine((list) => new Set(list).size === list.length, 'Duplicate permission')
  .transform((list) => list as Permission[]);

export const roleNameSchema = z.string().trim().min(2).max(60);

export const roleSchema = z.strictObject({
  id: objectIdSchema,
  name: z.string(),
  description: z.string(),
  system: z.boolean(),
  systemKey: z.enum(SYSTEM_ROLE_KEYS).nullable(),
  permissions: z.array(permissionSchema),
  memberCount: z.number().int(),
  version: z.number().int(),
});

export const roleCreateRequestSchema = z.strictObject({
  name: roleNameSchema,
  description: z.string().trim().max(300).default(''),
  permissions: permissionListSchema,
});

export const roleUpdateRequestSchema = z.strictObject({
  version: z.number().int().min(0),
  name: roleNameSchema.optional(),
  description: z.string().trim().max(300).optional(),
  permissions: permissionListSchema.optional(),
});

export const memberSchema = z.strictObject({
  id: objectIdSchema,
  userId: objectIdSchema,
  name: z.string(),
  email: z.string(),
  status: z.enum(['active', 'disabled']),
  roles: z.array(z.strictObject({ id: objectIdSchema, name: z.string() })),
  legalEntityIds: z.array(objectIdSchema).nullable(),
  /** null = every warehouse of the member's business entities. */
  warehouseIds: z.array(objectIdSchema).nullable(),
  mfaEnabled: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  isSelf: z.boolean(),
  version: z.number().int(),
});

const roleIdsSchema = z
  .array(objectIdSchema)
  .min(1, 'Choose at least one role')
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate role');

/** null = every legal entity (now and future); otherwise the listed ones (FR-RBAC-03). */
export const legalEntityScopeSchema = z
  .array(objectIdSchema)
  .min(1, 'Choose at least one business entity')
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate entity')
  .nullable();

/** null = every warehouse (in the entities the member can work in); otherwise the listed ones (FR-RBAC-03). */
export const warehouseScopeSchema = z
  .array(objectIdSchema)
  .min(1, 'Choose at least one warehouse')
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'Duplicate warehouse')
  .nullable();

export const memberUpdateRequestSchema = z.strictObject({
  version: z.number().int().min(0),
  roleIds: roleIdsSchema.optional(),
  legalEntityIds: legalEntityScopeSchema.optional(),
  warehouseIds: warehouseScopeSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const invitationSchema = z.strictObject({
  id: objectIdSchema,
  email: z.string(),
  roles: z.array(z.strictObject({ id: objectIdSchema, name: z.string() })),
  invitedBy: z.string(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export const invitationCreateRequestSchema = z.strictObject({ email: emailSchema, roleIds: roleIdsSchema, legalEntityIds: legalEntityScopeSchema.default(null), warehouseIds: warehouseScopeSchema.default(null) });

export const tenantContextSchema = z.strictObject({
  tenant: z.strictObject({ id: objectIdSchema, name: z.string() }),
  roles: z.array(z.strictObject({ id: objectIdSchema, name: z.string() })),
  permissions: z.array(permissionSchema),
  /** Legal entities the caller can act in for each permission they hold ("all" = every entity). */
  entityScopes: z.record(z.string(), z.union([z.literal('all'), z.array(objectIdSchema)])),
  /** Warehouses the caller can act in for each permission ("all" = every warehouse of the entities above). */
  warehouseScopes: z.record(z.string(), z.union([z.literal('all'), z.array(objectIdSchema)])),
  /** True when the server requires MFA enrolment before step-up permissions can be used. */
  mfaEnrolmentRequired: z.boolean(),
});

export const tenantUpdateRequestSchema = z.strictObject({ name: z.string().trim().min(2).max(120) });

export type Role = z.infer<typeof roleSchema>;
export type Member = z.infer<typeof memberSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type TenantContext = z.infer<typeof tenantContextSchema>;
