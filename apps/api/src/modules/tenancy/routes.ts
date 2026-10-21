import { Router, type Request } from 'express';
import {
  auditListQuerySchema,
  invitationCreateRequestSchema,
  memberUpdateRequestSchema,
  objectIdSchema,
  roleCreateRequestSchema,
  roleUpdateRequestSchema,
  tenantUpdateRequestSchema,
  type Permission,
  type TenantContext as TenantContextResponse,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { AuditLog } from '../audit/audit.js';
import type { IdentityService } from '../identity/identity.js';
import { warehouseScopeOf, type TenancyService, type TenantContext } from './tenancy.js';

interface Deps {
  config: AppConfig;
  now?: (() => Date) | undefined;
  identity: IdentityService;
  tenancy: TenancyService;
  audit: AuditLog;
}

/** Tenant-scoped routes. Every route runs after requireAuth + tenantContext (X-Tenant-Id validated against membership). */
export function tenancyRouter({ config, identity, tenancy, audit, now }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const can = (permission: Permission | Permission[], options?: { stepUp?: boolean }) => requirePermission(permission, config, { ...options, now });
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);

  router.get('/tenant/context', ...scoped, (req, res) => {
    const c = ctx(req);
    const body: TenantContextResponse = {
      tenant: { id: c.tenantId.toHexString(), name: c.tenantName },
      roles: c.roles.map((r) => ({ id: r.id.toHexString(), name: r.name })),
      permissions: [...c.permissions],
      entityScopes: Object.fromEntries([...c.scopes].map(([p, scope]) => [p, scope === 'all' ? 'all' : [...scope]])),
      warehouseScopes: Object.fromEntries(
        [...c.permissions].map((p) => {
          const scope = warehouseScopeOf(c, p);
          return [p, scope === 'all' ? 'all' : [...scope]];
        }),
      ),
      mfaEnrolmentRequired: config.mfaEnforcement === 'privileged' && !req.auth?.user.mfaEnabled,
    };
    res.json(body);
  });

  router.patch('/tenant', ...scoped, can('tenant.manage'), async (req, res) => {
    const { name } = tenantUpdateRequestSchema.parse(req.body);
    await tenancy.renameTenant(ctx(req), name, meta(req));
    res.status(204).end();
  });

  // Members
  router.get('/members', ...scoped, can('users.manage', { stepUp: false }), async (req, res) => {
    res.json({ data: await tenancy.listMembers(ctx(req)) });
  });

  router.patch('/members/:id', ...scoped, can('users.manage'), async (req, res) => {
    const input = memberUpdateRequestSchema.parse(req.body);
    res.json(await tenancy.updateMember(ctx(req), id(req), input, meta(req)));
  });

  router.post('/members/:id/revoke-sessions', ...scoped, can('users.manage'), async (req, res) => {
    res.json({ revoked: await tenancy.revokeMemberSessions(ctx(req), id(req), meta(req)) });
  });

  // Invitations
  router.get('/invitations', ...scoped, can('users.manage', { stepUp: false }), async (req, res) => {
    res.json({ data: await tenancy.listInvitations(ctx(req)) });
  });

  router.post('/invitations', ...scoped, can('users.manage'), async (req, res) => {
    const input = invitationCreateRequestSchema.parse(req.body);
    res.status(201).json(await tenancy.invite(ctx(req), input, meta(req)));
  });

  router.delete('/invitations/:id', ...scoped, can('users.manage'), async (req, res) => {
    await tenancy.revokeInvitation(ctx(req), id(req), meta(req));
    res.status(204).end();
  });

  // Roles (users.manage holders need the list to choose roles when inviting)
  router.get('/roles', ...scoped, can(['roles.manage', 'users.manage'], { stepUp: false }), async (req, res) => {
    res.json({ data: await tenancy.listRoles(ctx(req)) });
  });

  router.post('/roles', ...scoped, can('roles.manage'), async (req, res) => {
    const input = roleCreateRequestSchema.parse(req.body);
    res.status(201).json(await tenancy.createRole(ctx(req), input, meta(req)));
  });

  router.patch('/roles/:id', ...scoped, can('roles.manage'), async (req, res) => {
    const input = roleUpdateRequestSchema.parse(req.body);
    res.json(await tenancy.updateRole(ctx(req), id(req), input, meta(req)));
  });

  router.delete('/roles/:id', ...scoped, can('roles.manage'), async (req, res) => {
    await tenancy.archiveRole(ctx(req), id(req), meta(req));
    res.status(204).end();
  });

  // Audit log
  router.get('/audit-events', ...scoped, can('audit.view'), async (req, res) => {
    const query = auditListQuerySchema.parse(req.query);
    res.json(await audit.list(ctx(req).tenantId, query));
  });

  return router;
}
