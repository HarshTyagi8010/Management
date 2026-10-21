import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  movementListQuerySchema,
  objectIdSchema,
  stockAdjustmentInputSchema,
  stockAdjustmentUpdateSchema,
  stockCommandSchema,
  stockCountInputSchema,
  stockCountUpdateSchema,
  stockDocListQuerySchema,
  stockSummaryQuerySchema,
  stockTransferInputSchema,
  stockTransferUpdateSchema,
  warehouseInputSchema,
  warehouseUpdateSchema,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { idempotent } from '../../platform/idempotency.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { InventoryService } from './inventory.js';

interface Deps {
  config: AppConfig;
  models: Models;
  now?: (() => Date) | undefined;
  identity: IdentityService;
  tenancy: TenancyService;
  inventory: InventoryService;
}

/**
 * Inventory routes. Route guards check that the permission is held somewhere;
 * the service checks it for the specific warehouse or entity (FR-RBAC-03).
 *
 * Commands that move stock need an Idempotency-Key (architecture §7): a retry
 * with the same key replays the first response. Behind that, state and version
 * checks and the unique movement key still stop a document line from moving
 * stock twice.
 */
export function inventoryRouter({ config, models, now, identity, tenancy, inventory }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const version = (req: Request) => stockCommandSchema.parse(req.body).version;
  const can = (permissions: Parameters<typeof requirePermission>[0]) => requirePermission(permissions, config);

  const view = can('stock.view');
  const adjust = can('stock.adjust');
  const move = can('stock.move');
  const count = can(['stock.move', 'stock.count.post']);
  const once = idempotent(models, now);

  // Warehouses: names are visible to anyone working in the entity; changes are company settings.
  router.get('/warehouses', ...scoped, can(['stock.view', 'stock.move', 'stock.adjust', 'stock.count.post', 'settings.view', 'settings.company']), async (req, res) => {
    const query = z.strictObject({ legalEntityId: objectIdSchema.optional() }).parse(req.query);
    res.json({ data: await inventory.listWarehouses(ctx(req), query) });
  });
  router.post('/warehouses', ...scoped, can('settings.company'), async (req, res) => {
    res.status(201).json(await inventory.createWarehouse(ctx(req), warehouseInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/warehouses/:id', ...scoped, can('settings.company'), async (req, res) => {
    res.json(await inventory.updateWarehouse(ctx(req), id(req), warehouseUpdateSchema.parse(req.body), meta(req)));
  });

  // Enquiries
  router.get('/stock/summary', ...scoped, view, async (req, res) => {
    res.json(await inventory.stockSummary(ctx(req), stockSummaryQuerySchema.parse(req.query)));
  });
  router.get('/stock', ...scoped, view, async (req, res) => {
    let legalEntityId = req.query.legalEntityId as string | undefined;
    const warehouseId = req.query.warehouseId as string | undefined;
    const itemId = req.query.itemId as string | undefined;

    if (!legalEntityId && warehouseId) {
      const wh = await models.Warehouse.findOne({ tenantId: ctx(req).tenantId, _id: warehouseId }).lean();
      if (wh) legalEntityId = wh.legalEntityId.toHexString();
    }

    if (!legalEntityId) {
      throw new AppError('VALIDATION_FAILED', 'legalEntityId or warehouseId is required');
    }

    const summary = await inventory.stockSummary(ctx(req), {
      legalEntityId,
      warehouseId,
      limit: 100,
    });

    if (itemId) {
      summary.data = summary.data.filter((r) => r.itemId === itemId);
    }
    res.json(summary);
  });
  router.get('/stock/valuation', ...scoped, can('stock.view'), async (req, res) => {
    const { legalEntityId } = z.strictObject({ legalEntityId: objectIdSchema }).parse(req.query);
    res.json(await inventory.valuation(ctx(req), legalEntityId));
  });
  router.get('/stock/movements', ...scoped, view, async (req, res) => {
    res.json(await inventory.movements(ctx(req), movementListQuerySchema.parse(req.query)));
  });
  router.get('/stock/reconciliation', ...scoped, can(['stock.adjust', 'report.financial']), async (req, res) => {
    const { legalEntityId } = z.strictObject({ legalEntityId: objectIdSchema.optional() }).parse(req.query);
    res.json(await inventory.reconciliation(ctx(req), legalEntityId));
  });

  // Opening stock and adjustments
  router.get('/stock-adjustments', ...scoped, view, async (req, res) => {
    res.json(await inventory.listAdjustments(ctx(req), stockDocListQuerySchema.parse(req.query)));
  });
  router.get('/stock-adjustments/:id', ...scoped, view, async (req, res) => {
    res.json(await inventory.getAdjustment(ctx(req), id(req)));
  });
  router.post('/stock-adjustments', ...scoped, adjust, async (req, res) => {
    res.status(201).json(await inventory.createAdjustment(ctx(req), stockAdjustmentInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/stock-adjustments/:id', ...scoped, adjust, async (req, res) => {
    res.json(await inventory.updateAdjustment(ctx(req), id(req), stockAdjustmentUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/stock-adjustments/:id/post', ...scoped, adjust, once, async (req, res) => {
    res.json(await inventory.postAdjustment(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/stock-adjustments/:id/cancel', ...scoped, adjust, async (req, res) => {
    res.json(await inventory.cancelAdjustment(ctx(req), id(req), version(req), meta(req)));
  });

  // Transfers
  router.get('/stock-transfers', ...scoped, view, async (req, res) => {
    res.json(await inventory.listTransfers(ctx(req), stockDocListQuerySchema.parse(req.query)));
  });
  router.get('/stock-transfers/:id', ...scoped, view, async (req, res) => {
    res.json(await inventory.getTransfer(ctx(req), id(req)));
  });
  router.post('/stock-transfers', ...scoped, move, async (req, res) => {
    res.status(201).json(await inventory.createTransfer(ctx(req), stockTransferInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/stock-transfers/:id', ...scoped, move, async (req, res) => {
    res.json(await inventory.updateTransfer(ctx(req), id(req), stockTransferUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/stock-transfers/:id/dispatch', ...scoped, move, once, async (req, res) => {
    res.json(await inventory.dispatchTransfer(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/stock-transfers/:id/receive', ...scoped, move, once, async (req, res) => {
    res.json(await inventory.receiveTransfer(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/stock-transfers/:id/cancel', ...scoped, move, once, async (req, res) => {
    res.json(await inventory.cancelTransfer(ctx(req), id(req), version(req), meta(req)));
  });

  router.get('/stock-transfers/:id/pdf', ...scoped, can('document.download'), async (req, res) => {
    const { bytes, filename } = await inventory.transferPdf(ctx(req), id(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.send(bytes);
  });

  // Counts
  router.get('/stock-counts', ...scoped, view, async (req, res) => {
    res.json(await inventory.listCounts(ctx(req), stockDocListQuerySchema.parse(req.query)));
  });
  router.get('/stock-counts/:id', ...scoped, view, async (req, res) => {
    res.json(await inventory.getCount(ctx(req), id(req)));
  });
  router.post('/stock-counts', ...scoped, count, async (req, res) => {
    res.status(201).json(await inventory.createCount(ctx(req), stockCountInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/stock-counts/:id', ...scoped, count, async (req, res) => {
    res.json(await inventory.updateCount(ctx(req), id(req), stockCountUpdateSchema.parse(req.body), meta(req)));
  });
  for (const action of ['start', 'submit', 'reopen', 'cancel'] as const) {
    router.post(`/stock-counts/:id/${action}`, ...scoped, count, async (req, res) => {
      const run = { start: inventory.startCount, submit: inventory.submitCount, reopen: inventory.reopenCount, cancel: inventory.cancelCount }[action];
      res.json(await run.call(inventory, ctx(req), id(req), version(req), meta(req)));
    });
  }
  router.post('/stock-counts/:id/post', ...scoped, can('stock.count.post'), once, async (req, res) => {
    res.json(await inventory.postCount(ctx(req), id(req), version(req), meta(req)));
  });

  return router;
}
