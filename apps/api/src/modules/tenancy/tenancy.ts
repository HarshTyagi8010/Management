import { trusted, Types, type ClientSession, type Connection } from 'mongoose';
import {
  isPermission,
  PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_NAMES,
  SYSTEM_ROLE_PERMISSIONS,
  type AuditChange,
  type Invitation,
  type InvitationInspectResponse,
  type Member,
  type Permission,
  type Role,
  type SystemRoleKey,
  type TenantSummary,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import type { MembershipDoc, Models, RoleDoc, UserDoc } from '../../models.js';
import { randomToken, sha256 } from '../../platform/crypto.js';
import type { Mailer } from '../../platform/mailer.js';
import { CROSS_TENANT } from '../../platform/tenant-scope.js';
import { withTransaction } from '../../platform/transactions.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { Authenticated, IdentityService, RequestMeta } from '../identity/identity.js';

const INVITATION_LIFETIME_MS = 7 * 24 * 3_600_000;

const SYSTEM_ROLE_DESCRIPTIONS: Record<SystemRoleKey, string> = {
  owner: 'Full access, including billing and deleting the business.',
  admin: 'Manages users, roles and settings. Cannot unlock periods or change regulatory settings.',
  accountant: 'Billing, payments, GST, reports and period locks.',
  sales: 'Customers, quotations, orders and draft invoices.',
  storekeeper: 'Stock movements and dispatches.',
  purchase: 'Suppliers, purchase orders and receipts.',
  auditor: 'Read-only access to records, reports and the audit log.',
};

/** The validated tenant scope of a request (security.md §3). Built only from a membership lookup. */
export interface TenantContext {
  tenantId: Types.ObjectId;
  tenantName: string;
  userId: Types.ObjectId;
  membershipId: Types.ObjectId;
  roles: Array<{ id: Types.ObjectId; name: string }>;
  /** Every permission held in at least one legal entity. */
  permissions: ReadonlySet<Permission>;
  /** Where each permission applies (FR-RBAC-03): every legal entity, or the listed ids. */
  scopes: ReadonlyMap<Permission, EntityScope>;
  /** Per role assignment: the entities and warehouses where each permission applies. */
  grants: ReadonlyMap<Permission, readonly Grant[]>;
}

/** 'all' = every legal entity (or warehouse) of the tenant, including ones created later. */
export type EntityScope = 'all' | ReadonlySet<string>;

/** One role assignment's reach. Warehouse 'all' means every warehouse of the granted entities. */
export interface Grant {
  entities: EntityScope;
  warehouses: EntityScope;
}

const covers = (scope: EntityScope, id: string) => scope === 'all' || scope.has(id);
const toScope = (ids: Types.ObjectId[] | null | undefined): EntityScope => (ids ? new Set(ids.map((id) => id.toHexString())) : 'all');

/** Whether the caller holds `permission` in this warehouse: one assignment must cover both its entity and the warehouse. */
export function canInWarehouse(ctx: TenantContext, permission: Permission, warehouse: { _id: Types.ObjectId; legalEntityId: Types.ObjectId }): boolean {
  const entity = warehouse.legalEntityId.toHexString();
  const id = warehouse._id.toHexString();
  return (ctx.grants.get(permission) ?? []).some((g) => covers(g.entities, entity) && covers(g.warehouses, id));
}

/** Union of the warehouses a permission reaches (for the UI); 'all' if any assignment is unrestricted. */
export function warehouseScopeOf(ctx: TenantContext, permission: Permission): EntityScope {
  const ids = new Set<string>();
  for (const g of ctx.grants.get(permission) ?? []) {
    if (g.warehouses === 'all') return 'all';
    g.warehouses.forEach((id) => ids.add(id));
  }
  return ids;
}

/** Whether the caller holds `permission` for this legal entity. */
export function canInEntity(ctx: TenantContext, permission: Permission, legalEntityId: Types.ObjectId | string): boolean {
  const scope = ctx.scopes.get(permission);
  if (!scope) return false;
  return scope === 'all' || scope.has(typeof legalEntityId === 'string' ? legalEntityId : legalEntityId.toHexString());
}

/** Whether the caller holds `permission` for every legal entity (needed e.g. to create new entities). */
export const canInAllEntities = (ctx: TenantContext, permission: Permission) => ctx.scopes.get(permission) === 'all';

/** Entity ids the caller may see through any of the permissions, or 'all'. */
export function visibleEntities(ctx: TenantContext, permissions: readonly Permission[] = [...ctx.permissions]): EntityScope {
  const ids = new Set<string>();
  for (const p of permissions) {
    const scope = ctx.scopes.get(p);
    if (scope === 'all') return 'all';
    scope?.forEach((id) => ids.add(id));
  }
  return ids;
}

function mergeScope(current: EntityScope | undefined, next: Types.ObjectId[] | null): EntityScope {
  if (current === 'all' || next === null) return 'all';
  return new Set([...(current ?? []), ...next.map((id) => id.toHexString())]);
}

export function rolePermissions(role: Pick<RoleDoc, 'systemKey' | 'permissions'>): Permission[] {
  if (role.systemKey) return [...SYSTEM_ROLE_PERMISSIONS[role.systemKey]];
  return role.permissions.filter(isPermission);
}

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

export interface TenancyDeps {
  config: AppConfig;
  connection: Connection;
  models: Models;
  audit: AuditLog;
  mailer: Mailer;
  identity: IdentityService;
  now?: () => Date;
}

export class TenancyService {
  private readonly now: () => Date;

  constructor(private readonly deps: TenancyDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ------------------------------------------------------------ tenants

  /** Creates a tenant with the seven system roles and makes `ownerId` its Owner. Runs inside the caller's transaction. */
  async createTenantWithOwner(ownerId: Types.ObjectId, name: string, meta: RequestMeta, s: ClientSession): Promise<Types.ObjectId> {
    const { Tenant, Role, Membership } = this.deps.models;
    const tenantId = new Types.ObjectId();
    await Tenant.create([{ _id: tenantId, name, status: 'active', createdBy: ownerId, version: 0 }], { session: s });
    const roles = SYSTEM_ROLE_KEYS.map((key) => ({
      _id: new Types.ObjectId(),
      tenantId,
      name: SYSTEM_ROLE_NAMES[key],
      nameKey: SYSTEM_ROLE_NAMES[key].toLowerCase(),
      description: SYSTEM_ROLE_DESCRIPTIONS[key],
      systemKey: key,
      permissions: [],
      archivedAt: null,
      version: 0,
    }));
    await Role.create(roles, { session: s, ordered: true });
    const ownerRole = roles[0];
    if (!ownerRole) throw new Error('Owner role missing');
    await Membership.create(
      [{ tenantId, userId: ownerId, status: 'active', roleAssignments: [{ roleId: ownerRole._id, legalEntityIds: null, warehouseIds: null }], version: 0 }],
      { session: s },
    );
    await this.deps.audit.record(
      { tenantId, actorId: ownerId, action: 'tenant.created', entityType: 'tenant', entityId: tenantId.toHexString(), summary: `Created business "${name}"`, requestId: meta.requestId, ipHash: meta.ipHash },
      s,
    );
    return tenantId;
  }

  async listTenantsForUser(userId: Types.ObjectId): Promise<TenantSummary[]> {
    const memberships = await this.deps.models.Membership.find({ userId, status: 'active' }, { tenantId: 1 })
      .setOptions({ [CROSS_TENANT]: 'a user lists the tenants they belong to' })
      .lean();
    if (memberships.length === 0) return [];
    const tenants = await this.deps.models.Tenant.find({ _id: trusted({ $in: memberships.map((m) => m.tenantId) }), status: 'active' }, { name: 1 })
      .sort({ name: 1 })
      .lean();
    return tenants.map((t) => ({ id: t._id.toHexString(), name: t.name }));
  }

  /** Resolves the caller's context in a tenant, or null when they are not an active member (callers answer 404). */
  async loadContext(userId: Types.ObjectId, tenantId: Types.ObjectId): Promise<TenantContext | null> {
    const { Tenant, Membership, Role } = this.deps.models;
    const [tenant, membership] = await Promise.all([
      Tenant.findOne({ _id: tenantId, status: 'active' }, { name: 1 }).lean(),
      Membership.findOne({ tenantId, userId, status: 'active' }).lean(),
    ]);
    if (!tenant || !membership) return null;
    const roleIds = membership.roleAssignments.map((a) => a.roleId);
    const roles = await Role.find({ tenantId, _id: trusted({ $in: roleIds }), archivedAt: null }).lean();
    const roleById = new Map(roles.map((r) => [r._id.toHexString(), r]));
    const scopes = new Map<Permission, EntityScope>();
    const grants = new Map<Permission, Grant[]>();
    for (const assignment of membership.roleAssignments) {
      const role = roleById.get(assignment.roleId.toHexString());
      if (!role) continue;
      const grant: Grant = { entities: toScope(assignment.legalEntityIds), warehouses: toScope(assignment.warehouseIds) };
      for (const p of rolePermissions(role)) {
        scopes.set(p, mergeScope(scopes.get(p), assignment.legalEntityIds ?? null));
        grants.set(p, [...(grants.get(p) ?? []), grant]);
      }
    }
    return {
      tenantId,
      tenantName: tenant.name,
      userId,
      membershipId: membership._id,
      roles: roles.map((r) => ({ id: r._id, name: r.name })),
      permissions: new Set(scopes.keys()),
      scopes,
      grants,
    };
  }

  async renameTenant(ctx: TenantContext, name: string, meta: RequestMeta): Promise<void> {
    await this.deps.models.Tenant.updateOne({ _id: ctx.tenantId }, { $set: { name }, $inc: { version: 1 } });
    await this.record(ctx, meta, { action: 'tenant.updated', entityType: 'tenant', entityId: ctx.tenantId.toHexString(), summary: 'Renamed the business', changes: [{ field: 'name', from: ctx.tenantName, to: name }] });
  }

  // -------------------------------------------------------------- roles

  async listRoles(ctx: TenantContext): Promise<Role[]> {
    const { Role, Membership } = this.deps.models;
    const roles = await Role.find({ tenantId: ctx.tenantId, archivedAt: null }).sort({ systemKey: -1, nameKey: 1 }).lean();
    const counts = await Membership.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { tenantId: ctx.tenantId, status: 'active' } },
      { $unwind: '$roleAssignments' },
      { $group: { _id: '$roleAssignments.roleId', count: { $sum: 1 } } },
    ]);
    const countById = new Map(counts.map((c) => [c._id.toHexString(), c.count]));
    const order = (r: RoleDoc) => (r.systemKey ? SYSTEM_ROLE_KEYS.indexOf(r.systemKey) : SYSTEM_ROLE_KEYS.length);
    return roles.sort((a, b) => order(a) - order(b) || a.nameKey.localeCompare(b.nameKey)).map((r) => this.toRole(r, countById.get(r._id.toHexString()) ?? 0));
  }

  private toRole(r: RoleDoc, memberCount: number): Role {
    return {
      id: r._id.toHexString(),
      name: r.name,
      description: r.description,
      system: r.systemKey !== null,
      systemKey: r.systemKey,
      permissions: sortPermissions(rolePermissions(r)),
      memberCount,
      version: r.version,
    };
  }

  /**
   * Escalation guard: the actor must hold every permission they grant or take away.
   * With a scope (role assignments), one of the actor's own assignments must cover
   * it: someone limited to one legal entity or warehouse cannot grant access to
   * others, or to all.
   */
  private assertCanGrant(ctx: TenantContext, permissions: Iterable<Permission>, scope?: Types.ObjectId[] | null, warehouses: Types.ObjectId[] | null = null) {
    const within = (own: EntityScope, target: Types.ObjectId[] | null) => own === 'all' || (target !== null && target.every((id) => own.has(id.toHexString())));
    const missing = [...new Set(permissions)].filter((p) => {
      const own = ctx.grants.get(p);
      if (!own?.length) return true;
      if (scope === undefined) return false;
      return !own.some((g) => within(g.entities, scope) && within(g.warehouses, warehouses));
    });
    if (missing.length > 0) {
      throw new AppError(
        'FORBIDDEN',
        'You can only grant permissions that you have yourself, in the business entities where you have them',
        missing.map((p) => ({ path: 'permissions', message: p })),
      );
    }
  }

  /** Validates a legal-entity scope from the client: ids must be live entities of this tenant. */
  private async resolveScope(ctx: TenantContext, ids: string[] | null): Promise<Types.ObjectId[] | null> {
    if (ids === null) return null;
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const found = await this.deps.models.LegalEntity.countDocuments({ tenantId: ctx.tenantId, _id: trusted({ $in: objectIds }), archivedAt: null });
    if (found !== objectIds.length) {
      throw new AppError('VALIDATION_FAILED', 'Choose business entities from this business', [{ path: 'legalEntityIds', message: 'Unknown entity' }]);
    }
    return objectIds;
  }

  /**
   * Validates a warehouse scope: live warehouses of this tenant, inside the
   * entity scope when that is limited.
   */
  private async resolveWarehouses(ctx: TenantContext, ids: string[] | null, entityScope: Types.ObjectId[] | null): Promise<Types.ObjectId[] | null> {
    if (ids === null) return null;
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const warehouses = await this.deps.models.Warehouse.find({ tenantId: ctx.tenantId, _id: trusted({ $in: objectIds }), archivedAt: null }, { legalEntityId: 1 }).lean();
    if (warehouses.length !== objectIds.length) {
      throw new AppError('VALIDATION_FAILED', 'Choose warehouses from this business', [{ path: 'warehouseIds', message: 'Unknown warehouse' }]);
    }
    if (entityScope && warehouses.some((w) => !entityScope.some((e) => e.equals(w.legalEntityId)))) {
      throw new AppError('VALIDATION_FAILED', 'Choose warehouses of the selected business entities', [{ path: 'warehouseIds', message: 'Outside the chosen entities' }]);
    }
    return objectIds;
  }

  private assertOwnerUnscoped(roles: RoleDoc[], scope: Types.ObjectId[] | null, warehouses: Types.ObjectId[] | null = null) {
    if ((scope !== null || warehouses !== null) && roles.some((r) => r.systemKey === 'owner')) {
      throw new AppError('VALIDATION_FAILED', 'The Owner role always covers every business entity and warehouse', [{ path: scope !== null ? 'legalEntityIds' : 'warehouseIds', message: 'Owner cannot be limited' }]);
    }
  }

  async createRole(ctx: TenantContext, input: { name: string; description: string; permissions: Permission[] }, meta: RequestMeta): Promise<Role> {
    this.assertCanGrant(ctx, input.permissions);
    const doc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      name: input.name,
      nameKey: input.name.toLowerCase(),
      description: input.description,
      systemKey: null,
      permissions: sortPermissions(input.permissions),
      archivedAt: null,
      version: 0,
    };
    try {
      await this.deps.models.Role.create([doc]);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError('DUPLICATE', 'A role with this name already exists');
      throw err;
    }
    await this.record(ctx, meta, { action: 'role.created', entityType: 'role', entityId: doc._id.toHexString(), summary: `Created role "${doc.name}"`, changes: [{ field: 'permissions', to: doc.permissions }] });
    return this.toRole({ ...doc, createdAt: this.now(), updatedAt: this.now() }, 0);
  }

  private async findRole(ctx: TenantContext, roleId: string): Promise<RoleDoc> {
    const role = await this.deps.models.Role.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(roleId), archivedAt: null }).lean();
    if (!role) throw notFound('Role');
    return role;
  }

  async updateRole(ctx: TenantContext, roleId: string, input: { version: number; name?: string | undefined; description?: string | undefined; permissions?: Permission[] | undefined }, meta: RequestMeta): Promise<Role> {
    const role = await this.findRole(ctx, roleId);
    if (role.systemKey) throw new AppError('BUSINESS_RULE', 'System roles cannot be changed. Make a copy and edit that instead.');
    const before = rolePermissions(role);
    this.assertCanGrant(ctx, before);
    const changes: AuditChange[] = [];
    const set: Partial<RoleDoc> = {};
    if (input.permissions) {
      this.assertCanGrant(ctx, input.permissions);
      const added = input.permissions.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !input.permissions?.includes(p));
      if (added.length || removed.length) changes.push({ field: 'permissions', from: removed, to: added });
      set.permissions = sortPermissions(input.permissions);
    }
    if (input.name !== undefined && input.name !== role.name) {
      changes.push({ field: 'name', from: role.name, to: input.name });
      set.name = input.name;
      set.nameKey = input.name.toLowerCase();
    }
    if (input.description !== undefined && input.description !== role.description) {
      changes.push({ field: 'description' });
      set.description = input.description;
    }
    let updated: RoleDoc | null;
    try {
      updated = await this.deps.models.Role.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: role._id, version: input.version, archivedAt: null },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      ).lean();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw new AppError('DUPLICATE', 'A role with this name already exists');
      throw err;
    }
    if (!updated) throw new AppError('VERSION_CONFLICT', 'This role was changed by someone else. Reload and try again.');
    if (changes.length) await this.record(ctx, meta, { action: 'role.updated', entityType: 'role', entityId: roleId, summary: `Updated role "${updated.name}"`, changes });
    return this.toRole(updated, await this.countMembersWithRole(ctx, updated._id));
  }

  private countMembersWithRole(ctx: TenantContext, roleId: Types.ObjectId) {
    return this.deps.models.Membership.countDocuments({ tenantId: ctx.tenantId, status: 'active', 'roleAssignments.roleId': roleId });
  }

  async archiveRole(ctx: TenantContext, roleId: string, meta: RequestMeta): Promise<void> {
    const role = await this.findRole(ctx, roleId);
    if (role.systemKey) throw new AppError('BUSINESS_RULE', 'System roles cannot be removed');
    this.assertCanGrant(ctx, rolePermissions(role));
    const inUse = await this.deps.models.Membership.countDocuments({ tenantId: ctx.tenantId, 'roleAssignments.roleId': role._id });
    if (inUse > 0) throw new AppError('BUSINESS_RULE', `Remove this role from ${inUse} member${inUse === 1 ? '' : 's'} first`);
    await this.deps.models.Role.updateOne({ tenantId: ctx.tenantId, _id: role._id }, { $set: { archivedAt: this.now() }, $inc: { version: 1 } });
    await this.record(ctx, meta, { action: 'role.archived', entityType: 'role', entityId: roleId, summary: `Removed role "${role.name}"` });
  }

  /** Loads active roles of this tenant by id; any unknown id fails validation (no cross-tenant leak). */
  private async rolesForAssignment(ctx: TenantContext, roleIds: string[]): Promise<RoleDoc[]> {
    const ids = roleIds.map((id) => new Types.ObjectId(id));
    const roles = await this.deps.models.Role.find({ tenantId: ctx.tenantId, _id: trusted({ $in: ids }), archivedAt: null }).lean();
    if (roles.length !== ids.length) throw new AppError('VALIDATION_FAILED', 'Choose roles from this business', [{ path: 'roleIds', message: 'Unknown role' }]);
    return roles;
  }

  // ------------------------------------------------------------ members

  async listMembers(ctx: TenantContext): Promise<Member[]> {
    const { Membership, User, Role } = this.deps.models;
    const memberships = await Membership.find({ tenantId: ctx.tenantId }).sort({ createdAt: 1 }).limit(500).lean();
    const [users, roles] = await Promise.all([
      User.find({ _id: trusted({ $in: memberships.map((m) => m.userId) }) }, { name: 1, email: 1, mfaEnabled: 1, lastLoginAt: 1 }).lean(),
      Role.find({ tenantId: ctx.tenantId, archivedAt: null }, { name: 1 }).lean(),
    ]);
    const userById = new Map(users.map((u) => [u._id.toHexString(), u]));
    const roleName = new Map(roles.map((r) => [r._id.toHexString(), r.name]));
    return memberships.flatMap((m) => {
      const user = userById.get(m.userId.toHexString());
      return user ? [this.toMember(m, user, roleName, ctx)] : [];
    });
  }

  private toMember(m: MembershipDoc, user: Pick<UserDoc, 'name' | 'email' | 'mfaEnabled' | 'lastLoginAt'>, roleName: Map<string, string>, ctx: TenantContext): Member {
    return {
      id: m._id.toHexString(),
      userId: m.userId.toHexString(),
      name: user.name,
      email: user.email,
      status: m.status,
      roles: m.roleAssignments.flatMap((a) => {
        const name = roleName.get(a.roleId.toHexString());
        return name ? [{ id: a.roleId.toHexString(), name }] : [];
      }),
      // The UI gives all of a member's roles one scope; the first assignment carries it.
      legalEntityIds: m.roleAssignments[0]?.legalEntityIds?.map((id) => id.toHexString()) ?? null,
      warehouseIds: m.roleAssignments[0]?.warehouseIds?.map((id) => id.toHexString()) ?? null,
      mfaEnabled: user.mfaEnabled,
      lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
      isSelf: m.userId.equals(ctx.userId),
      version: m.version,
    };
  }

  private async findMember(ctx: TenantContext, memberId: string): Promise<MembershipDoc> {
    const m = await this.deps.models.Membership.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(memberId) }).lean();
    if (!m) throw notFound('Member');
    return m;
  }

  /** The member's current permissions; the actor must hold all of them to manage the member (admins cannot manage owners). */
  private async assertCanManageMember(ctx: TenantContext, member: MembershipDoc) {
    if (member.userId.equals(ctx.userId)) throw new AppError('BUSINESS_RULE', "You can't change your own access. Ask another administrator.");
    const roles = await this.deps.models.Role.find({ tenantId: ctx.tenantId, _id: trusted({ $in: member.roleAssignments.map((a) => a.roleId) }) }).lean();
    const roleById = new Map(roles.map((r) => [r._id.toHexString(), r]));
    for (const assignment of member.roleAssignments) {
      const role = roleById.get(assignment.roleId.toHexString());
      if (role) this.assertCanGrant(ctx, rolePermissions(role), assignment.legalEntityIds ?? null, assignment.warehouseIds ?? null);
    }
  }

  /**
   * Bumps the tenant version inside membership transactions. Two concurrent
   * transactions that could each remove "the other" owner then conflict on this
   * write, so one retries and sees the other's change (prevents write skew).
   */
  private async lockTenant(ctx: TenantContext, s: ClientSession) {
    await this.deps.models.Tenant.updateOne({ _id: ctx.tenantId }, { $inc: { version: 1 } }, { session: s });
  }

  private async assertOwnerRemains(ctx: TenantContext, s: ClientSession) {
    const owner = await this.deps.models.Role.findOne({ tenantId: ctx.tenantId, systemKey: 'owner' }, { _id: 1 }, { session: s }).lean();
    const owners = owner ? await this.deps.models.Membership.countDocuments({ tenantId: ctx.tenantId, status: 'active', 'roleAssignments.roleId': owner._id }, { session: s }) : 0;
    if (owners === 0) throw new AppError('BUSINESS_RULE', 'A business must keep at least one active Owner');
  }

  async updateMember(
    ctx: TenantContext,
    memberId: string,
    input: { version: number; roleIds?: string[] | undefined; legalEntityIds?: string[] | null | undefined; warehouseIds?: string[] | null | undefined; status?: 'active' | 'disabled' | undefined },
    meta: RequestMeta,
  ): Promise<Member> {
    const member = await this.findMember(ctx, memberId);
    await this.assertCanManageMember(ctx, member);
    const changes: AuditChange[] = [];
    const set: Record<string, unknown> = {};
    const allRoles = await this.deps.models.Role.find({ tenantId: ctx.tenantId }, { name: 1 }).lean();
    const roleName = new Map(allRoles.map((r) => [r._id.toHexString(), r.name]));
    if (input.roleIds || input.legalEntityIds !== undefined || input.warehouseIds !== undefined) {
      const currentScope = member.roleAssignments[0]?.legalEntityIds ?? null;
      const currentWarehouses = member.roleAssignments[0]?.warehouseIds ?? null;
      const scope = input.legalEntityIds === undefined ? currentScope : await this.resolveScope(ctx, input.legalEntityIds);
      const warehouses = await this.resolveWarehouses(ctx, input.warehouseIds === undefined ? (currentWarehouses?.map((id) => id.toHexString()) ?? null) : input.warehouseIds, scope);
      const roles = await this.rolesForAssignment(ctx, input.roleIds ?? member.roleAssignments.map((a) => a.roleId.toHexString()));
      this.assertOwnerUnscoped(roles, scope, warehouses);
      this.assertCanGrant(ctx, roles.flatMap(rolePermissions), scope, warehouses);
      set.roleAssignments = roles.map((r) => ({ roleId: r._id, legalEntityIds: scope, warehouseIds: warehouses }));
      if (input.warehouseIds !== undefined) {
        changes.push({ field: 'warehouses', from: currentWarehouses?.map((id) => id.toHexString()) ?? 'all', to: warehouses?.map((id) => id.toHexString()) ?? 'all' });
      }
      if (input.roleIds) {
        changes.push({ field: 'roles', from: member.roleAssignments.map((a) => roleName.get(a.roleId.toHexString()) ?? 'removed role'), to: roles.map((r) => r.name) });
      }
      if (input.legalEntityIds !== undefined) {
        changes.push({ field: 'legalEntities', from: currentScope?.map((id) => id.toHexString()) ?? 'all', to: scope?.map((id) => id.toHexString()) ?? 'all' });
      }
    }
    if (input.status && input.status !== member.status) {
      set.status = input.status;
      changes.push({ field: 'status', from: member.status, to: input.status });
    }
    const updated = await withTransaction(this.deps.connection, async (s) => {
      await this.lockTenant(ctx, s);
      const doc = await this.deps.models.Membership.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: member._id, version: input.version },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after', session: s },
      ).lean();
      if (!doc) throw new AppError('VERSION_CONFLICT', 'This member was changed by someone else. Reload and try again.');
      await this.assertOwnerRemains(ctx, s);
      if (changes.length) {
        await this.deps.audit.record(this.auditInput(ctx, meta, { action: 'member.updated', entityType: 'member', entityId: memberId, summary: 'Changed member access', changes }), s);
      }
      return doc;
    });
    const user = await this.deps.models.User.findById(updated.userId, { name: 1, email: 1, mfaEnabled: 1, lastLoginAt: 1 }).lean();
    if (!user) throw notFound('Member');
    return this.toMember(updated, user, roleName, ctx);
  }

  /** Signs the member out everywhere. Sessions are per user, so this also ends their sessions in other businesses. */
  async revokeMemberSessions(ctx: TenantContext, memberId: string, meta: RequestMeta): Promise<number> {
    const member = await this.findMember(ctx, memberId);
    await this.assertCanManageMember(ctx, member);
    const count = await this.deps.identity.revokeAllSessions(member.userId);
    await this.record(ctx, meta, { action: 'member.sessions_revoked', entityType: 'member', entityId: memberId, summary: `Signed the member out of ${count} session${count === 1 ? '' : 's'}` });
    return count;
  }

  // -------------------------------------------------------- invitations

  async listInvitations(ctx: TenantContext): Promise<Invitation[]> {
    const { Invitation, Role, User } = this.deps.models;
    const invitations = await Invitation.find({ tenantId: ctx.tenantId, status: 'pending', expiresAt: trusted({ $gt: this.now() }) }).sort({ createdAt: -1 }).limit(200).lean();
    const [roles, inviters] = await Promise.all([
      Role.find({ tenantId: ctx.tenantId }, { name: 1 }).lean(),
      User.find({ _id: trusted({ $in: invitations.map((i) => i.invitedBy) }) }, { name: 1 }).lean(),
    ]);
    const roleName = new Map(roles.map((r) => [r._id.toHexString(), r.name]));
    const inviterName = new Map(inviters.map((u) => [u._id.toHexString(), u.name]));
    return invitations.map((i) => ({
      id: i._id.toHexString(),
      email: i.email,
      roles: i.roleIds.flatMap((id) => {
        const name = roleName.get(id.toHexString());
        return name ? [{ id: id.toHexString(), name }] : [];
      }),
      invitedBy: inviterName.get(i.invitedBy.toHexString()) ?? 'Unknown',
      createdAt: i.createdAt.toISOString(),
      expiresAt: i.expiresAt.toISOString(),
    }));
  }

  async invite(ctx: TenantContext, input: { email: string; roleIds: string[]; legalEntityIds?: string[] | null | undefined; warehouseIds?: string[] | null | undefined }, meta: RequestMeta): Promise<Invitation> {
    const { mailer, models } = this.deps;
    if (!mailer.enabled) throw new AppError('BUSINESS_RULE', 'Invitations are sent by email, and email delivery is not configured for this installation');
    const roles = await this.rolesForAssignment(ctx, input.roleIds);
    const scope = await this.resolveScope(ctx, input.legalEntityIds ?? null);
    const warehouses = await this.resolveWarehouses(ctx, input.warehouseIds ?? null, scope);
    this.assertOwnerUnscoped(roles, scope, warehouses);
    this.assertCanGrant(ctx, roles.flatMap(rolePermissions), scope, warehouses);
    const existingUser = await models.User.findOne({ email: input.email }, { _id: 1 }).lean();
    if (existingUser && (await models.Membership.countDocuments({ tenantId: ctx.tenantId, userId: existingUser._id, status: 'active' })) > 0) {
      throw new AppError('DUPLICATE', 'This person is already a member');
    }
    const token = randomToken();
    const now = this.now();
    const id = new Types.ObjectId();
    await withTransaction(this.deps.connection, async (s) => {
      // A new invitation replaces any pending one for the same email.
      await models.Invitation.updateMany({ tenantId: ctx.tenantId, email: input.email, status: 'pending' }, { $set: { status: 'revoked' } }, { session: s });
      await models.Invitation.create(
        [{ _id: id, tenantId: ctx.tenantId, email: input.email, roleIds: roles.map((r) => r._id), legalEntityIds: scope, warehouseIds: warehouses, tokenHash: sha256(token), invitedBy: ctx.userId, status: 'pending', expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS), acceptedBy: null }],
        { session: s },
      );
      await this.deps.audit.record(this.auditInput(ctx, meta, { action: 'member.invited', entityType: 'invitation', entityId: id.toHexString(), summary: `Invited ${input.email}`, changes: [{ field: 'roles', to: roles.map((r) => r.name) }] }), s);
    });
    const inviter = await models.User.findById(ctx.userId, { name: 1 }).lean();
    this.deps.identity.sendLater({
      to: input.email,
      subject: `You're invited to ${ctx.tenantName} on BizMgmt`,
      text: [
        `${inviter?.name ?? 'A colleague'} invited you to join ${ctx.tenantName} on BizMgmt as ${roles.map((r) => r.name).join(', ')}.`,
        '',
        'Accept within 7 days:',
        `${this.deps.config.publicAppUrl}/accept-invite#token=${token}`,
        '',
        'If you were not expecting this, you can ignore this email.',
      ].join('\n'),
    });
    return {
      id: id.toHexString(),
      email: input.email,
      roles: roles.map((r) => ({ id: r._id.toHexString(), name: r.name })),
      invitedBy: inviter?.name ?? 'Unknown',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITATION_LIFETIME_MS).toISOString(),
    };
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string, meta: RequestMeta): Promise<void> {
    const res = await this.deps.models.Invitation.findOneAndUpdate(
      { tenantId: ctx.tenantId, _id: new Types.ObjectId(invitationId), status: 'pending' },
      { $set: { status: 'revoked' } },
    ).lean();
    if (!res) throw notFound('Invitation');
    await this.record(ctx, meta, { action: 'member.invitation_revoked', entityType: 'invitation', entityId: invitationId, summary: `Cancelled the invitation for ${res.email}` });
  }

  private async findLiveInvitation(token: string) {
    const invitation = await this.deps.models.Invitation.findOne({ tokenHash: sha256(token), status: 'pending', expiresAt: trusted({ $gt: this.now() }) })
      .setOptions({ [CROSS_TENANT]: 'the invitation token identifies the tenant' })
      .lean();
    const tenant = invitation ? await this.deps.models.Tenant.findOne({ _id: invitation.tenantId, status: 'active' }, { name: 1 }).lean() : null;
    if (!invitation || !tenant) throw new AppError('NOT_FOUND', 'This invitation is invalid or has expired. Ask for a new one.');
    return { invitation, tenant };
  }

  async inspectInvitation(token: string): Promise<InvitationInspectResponse> {
    const { invitation, tenant } = await this.findLiveInvitation(token);
    const accountExists = (await this.deps.models.User.countDocuments({ email: invitation.email })) > 0;
    return { tenantName: tenant.name, email: invitation.email, accountExists };
  }

  /**
   * Accepts an invitation. An existing account must be signed in; otherwise a new
   * account is created (holding the emailed token proves the address).
   * Returns the user id and whether a new session must be started.
   */
  async acceptInvitation(
    token: string,
    auth: Authenticated | undefined,
    input: { name?: string | undefined; password?: string | undefined },
    meta: RequestMeta,
  ): Promise<{ userId: Types.ObjectId; tenantId: Types.ObjectId; newAccount: boolean }> {
    const { invitation, tenant } = await this.findLiveInvitation(token);
    const { models } = this.deps;
    const existing = await models.User.findOne({ email: invitation.email }).lean();
    if (existing) {
      if (!auth || auth.session.mfaState !== 'complete') throw new AppError('UNAUTHENTICATED', `Sign in as ${invitation.email} to accept this invitation`);
      if (!auth.user._id.equals(existing._id)) throw new AppError('FORBIDDEN', 'This invitation is for a different account. Sign out and sign in with the invited email.');
    } else if (!input.name || !input.password) {
      throw new AppError('VALIDATION_FAILED', 'Enter your name and choose a password', [
        ...(input.name ? [] : [{ path: 'name', message: 'Required' }]),
        ...(input.password ? [] : [{ path: 'password', message: 'Required' }]),
      ]);
    }
    const roles = await models.Role.find({ tenantId: invitation.tenantId, _id: trusted({ $in: invitation.roleIds }), archivedAt: null }).lean();
    if (roles.length === 0) throw new AppError('BUSINESS_RULE', 'The roles in this invitation no longer exist. Ask for a new invitation.');

    const userId = await withTransaction(this.deps.connection, async (s) => {
      const user =
        existing ??
        (await this.deps.identity.createUser({ name: input.name ?? '', email: invitation.email, password: input.password ?? '', emailVerified: true, lastTenantId: invitation.tenantId }, s));
      const claimed = await models.Invitation.updateOne(
        { tenantId: invitation.tenantId, _id: invitation._id, status: 'pending' },
        { $set: { status: 'accepted', acceptedBy: user._id } },
        { session: s },
      );
      if (claimed.modifiedCount !== 1) throw new AppError('NOT_FOUND', 'This invitation is invalid or has expired. Ask for a new one.');
      await models.Membership.updateOne(
        { tenantId: invitation.tenantId, userId: user._id },
        {
          $set: { status: 'active', roleAssignments: roles.map((r) => ({ roleId: r._id, legalEntityIds: invitation.legalEntityIds ?? null, warehouseIds: invitation.warehouseIds ?? null })) },
          $inc: { version: 1 },
        },
        { upsert: true, session: s },
      );
      await models.User.updateOne({ _id: user._id }, { $set: { lastTenantId: invitation.tenantId, ...(existing?.emailVerifiedAt ? {} : { emailVerifiedAt: this.now() }) } }, { session: s });
      await this.deps.audit.record(
        { tenantId: invitation.tenantId, actorId: user._id, action: 'member.joined', entityType: 'member', entityId: user._id.toHexString(), summary: `${invitation.email} joined ${tenant.name}`, changes: [{ field: 'roles', to: roles.map((r) => r.name) }], requestId: meta.requestId, ipHash: meta.ipHash },
        s,
      );
      return user._id;
    });
    return { userId, tenantId: invitation.tenantId, newAccount: !existing };
  }

  // ------------------------------------------------------------ helpers

  private auditInput(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>): AuditInput {
    return { ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash };
  }

  private record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>) {
    return this.deps.audit.record(this.auditInput(ctx, meta, input));
  }
}

const PERMISSION_ORDER = new Map<string, number>(PERMISSIONS.map((p, i) => [p, i]));
function sortPermissions(list: Permission[]): Permission[] {
  return [...list].sort((a, b) => (PERMISSION_ORDER.get(a) ?? 0) - (PERMISSION_ORDER.get(b) ?? 0));
}
