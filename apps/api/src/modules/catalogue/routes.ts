import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  categoryInputSchema,
  categoryUpdateSchema,
  itemInputSchema,
  itemListQuerySchema,
  itemUpdateSchema,
  objectIdSchema,
  rateScheduleInputSchema,
  taxClassInputSchema,
  taxClassUpdateSchema,
  unitInputSchema,
  unitUpdateSchema,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { CatalogueService } from './catalogue.js';

interface Deps {
  config: AppConfig;
  identity: IdentityService;
  tenancy: TenancyService;
  catalogue: CatalogueService;
}

const version = z.number().int().min(0);
const scheduleUpdateSchema = z.union([z.strictObject({ version, effectiveTo: z.iso.date().nullable() }), z.strictObject({ version, remove: z.literal(true) })]);

export function catalogueRouter({ config, identity, tenancy, catalogue }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request, name = 'id') => objectIdSchema.parse(req.params[name]);
  const view = requirePermission('item.view', config);
  const edit = requirePermission('item.edit', config);
  const taxView = requirePermission(['tax.view', 'tax.manage', 'item.edit'], config);
  const taxManage = requirePermission('tax.manage', config);

  router.get('/units', ...scoped, view, async (req, res) => {
    res.json({ data: await catalogue.listUnits(ctx(req)) });
  });
  router.post('/units', ...scoped, edit, async (req, res) => {
    res.status(201).json(await catalogue.createUnit(ctx(req), unitInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/units/:id', ...scoped, edit, async (req, res) => {
    res.json(await catalogue.updateUnit(ctx(req), id(req), unitUpdateSchema.parse(req.body), meta(req)));
  });

  router.get('/categories', ...scoped, view, async (req, res) => {
    res.json({ data: await catalogue.listCategories(ctx(req)) });
  });
  router.post('/categories', ...scoped, edit, async (req, res) => {
    res.status(201).json(await catalogue.createCategory(ctx(req), categoryInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/categories/:id', ...scoped, edit, async (req, res) => {
    res.json(await catalogue.updateCategory(ctx(req), id(req), categoryUpdateSchema.parse(req.body), meta(req)));
  });

  // People who edit items need to pick a tax class, so item.edit may read classes too.
  router.get('/tax-classes', ...scoped, taxView, async (req, res) => {
    res.json({ data: await catalogue.listTaxClasses(ctx(req)) });
  });
  router.post('/tax-classes', ...scoped, taxManage, async (req, res) => {
    res.status(201).json(await catalogue.createTaxClass(ctx(req), taxClassInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/tax-classes/:id', ...scoped, taxManage, async (req, res) => {
    res.json(await catalogue.updateTaxClass(ctx(req), id(req), taxClassUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/tax-classes/:id/schedules', ...scoped, taxManage, async (req, res) => {
    const body = rateScheduleInputSchema.and(z.object({ version })).parse(req.body);
    res.status(201).json(await catalogue.addSchedule(ctx(req), id(req), body, meta(req)));
  });
  router.patch('/tax-classes/:id/schedules/:scheduleId', ...scoped, taxManage, async (req, res) => {
    res.json(await catalogue.updateSchedule(ctx(req), id(req), id(req, 'scheduleId'), scheduleUpdateSchema.parse(req.body), meta(req)));
  });

  router.get('/items', ...scoped, view, async (req, res) => {
    res.json(await catalogue.listItems(ctx(req), itemListQuerySchema.parse(req.query)));
  });
  router.get('/items/:id', ...scoped, view, async (req, res) => {
    res.json(await catalogue.getItem(ctx(req), id(req)));
  });
  router.post('/items', ...scoped, edit, async (req, res) => {
    res.status(201).json(await catalogue.createItem(ctx(req), itemInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/items/:id', ...scoped, edit, async (req, res) => {
    res.json(await catalogue.updateItem(ctx(req), id(req), itemUpdateSchema.parse(req.body), meta(req)));
  });

  return router;
}
