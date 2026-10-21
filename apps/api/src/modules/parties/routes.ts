import { Router, type Request } from 'express';
import { noteInputSchema, objectIdSchema, partyInputSchema, partyListQuerySchema, partyUpdateSchema, taskInputSchema, taskListQuerySchema, taskUpdateSchema } from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { PartiesService } from './parties.js';

interface Deps {
  config: AppConfig;
  identity: IdentityService;
  tenancy: TenancyService;
  parties: PartiesService;
}

export function partiesRouter({ config, identity, tenancy, parties }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const view = requirePermission(['party.view', 'party.view_basic'], config);
  const viewFull = requirePermission('party.view', config);
  const edit = requirePermission('party.edit', config);
  const crm = requirePermission('crm.tasks', config);

  router.get('/parties', ...scoped, view, async (req, res) => {
    res.json(await parties.list(ctx(req), partyListQuerySchema.parse(req.query)));
  });
  router.get('/parties/:id', ...scoped, view, async (req, res) => {
    res.json(await parties.get(ctx(req), id(req)));
  });
  router.post('/parties', ...scoped, edit, async (req, res) => {
    res.status(201).json(await parties.create(ctx(req), partyInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/parties/:id', ...scoped, edit, async (req, res) => {
    res.json(await parties.update(ctx(req), id(req), partyUpdateSchema.parse(req.body), meta(req)));
  });

  router.get('/parties/:id/timeline', ...scoped, viewFull, async (req, res) => {
    res.json({ data: await parties.timeline(ctx(req), id(req)) });
  });
  router.post('/parties/:id/notes', ...scoped, crm, async (req, res) => {
    res.status(201).json(await parties.addNote(ctx(req), id(req), noteInputSchema.parse(req.body).body));
  });
  router.post('/parties/:id/tasks', ...scoped, crm, async (req, res) => {
    res.status(201).json(await parties.createTask(ctx(req), id(req), taskInputSchema.parse(req.body), meta(req)));
  });
  router.get('/crm-tasks', ...scoped, crm, async (req, res) => {
    res.json({ data: await parties.listTasks(ctx(req), taskListQuerySchema.parse(req.query)) });
  });
  router.patch('/crm-tasks/:id', ...scoped, crm, async (req, res) => {
    res.json(await parties.updateTask(ctx(req), id(req), taskUpdateSchema.parse(req.body), meta(req)));
  });

  return router;
}
