import { Router, type Request, type Response } from 'express';
import {
  cancelPurchaseDocCommandSchema,
  createGoodsReceiptSchema,
  createPurchaseOrderSchema,
  createSupplierBillSchema,
  issuePurchaseOrderCommandSchema,
  objectIdSchema,
  payablesQuerySchema,
  purchaseDocCommandSchema,
  purchaseDocListQuerySchema,
  updateGoodsReceiptSchema,
  updatePurchaseOrderSchema,
  updateSupplierBillSchema,
  type Permission,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { idempotent } from '../../platform/idempotency.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { PurchaseOrderService } from './orders.js';
import type { GoodsReceiptService } from './receipts.js';
import type { SupplierBillService } from './bills.js';
import { payables } from './payables.js';

interface Deps {
  config: AppConfig;
  models: Models;
  now?: (() => Date) | undefined;
  identity: IdentityService;
  tenancy: TenancyService;
  orders: PurchaseOrderService;
  receipts: GoodsReceiptService;
  bills: SupplierBillService;
}

export function purchasesRouter({ config, models, now, identity, tenancy, orders, receipts, bills }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const can = (permissions: Permission | Permission[]) => requirePermission(permissions, config);
  const once = idempotent(models, now);

  // -------------------------------------------------------------------------
  // Purchase Orders
  // -------------------------------------------------------------------------
  router.get(['/purchases/orders', '/purchase-orders'], ...scoped, can(['purchase.edit', 'purchase.issue']), async (req, res) => {
    const query = purchaseDocListQuerySchema.parse(req.query);
    res.json(await orders.list(ctx(req), query));
  });

  router.get(['/purchases/orders/:id', '/purchase-orders/:id'], ...scoped, can(['purchase.edit', 'purchase.issue']), async (req, res) => {
    res.json(await orders.getById(ctx(req), id(req)));
  });

  router.post(['/purchases/orders', '/purchase-orders'], ...scoped, can('purchase.edit'), async (req, res) => {
    const input = createPurchaseOrderSchema.parse(req.body);
    res.status(201).json(await orders.createDraft(ctx(req), input, meta(req)));
  });

  router.put(['/purchases/orders/:id', '/purchase-orders/:id'], ...scoped, can('purchase.edit'), async (req, res) => {
    const input = createPurchaseOrderSchema.parse(req.body);
    res.json(await orders.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.patch(['/purchases/orders/:id', '/purchase-orders/:id'], ...scoped, can('purchase.edit'), async (req, res) => {
    const input = createPurchaseOrderSchema.parse(req.body);
    res.json(await orders.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.post(['/purchases/orders/:id/issue', '/purchase-orders/:id/issue'], ...scoped, can('purchase.issue'), once, async (req, res) => {
    const body = issuePurchaseOrderCommandSchema.parse(req.body ?? {});
    res.json(await orders.issue(ctx(req), id(req), meta(req), body.seriesId));
  });

  router.post(['/purchases/orders/:id/cancel', '/purchase-orders/:id/cancel'], ...scoped, can('purchase.issue'), once, async (req, res) => {
    const body = cancelPurchaseDocCommandSchema.parse(req.body);
    res.json(await orders.cancel(ctx(req), id(req), body.reason, meta(req)));
  });

  router.post(['/purchases/orders/:id/close', '/purchase-orders/:id/close'], ...scoped, can('purchase.issue'), once, async (req, res) => {
    const body = cancelPurchaseDocCommandSchema.parse(req.body);
    res.json(await orders.close(ctx(req), id(req), body.reason, meta(req)));
  });

  router.post(['/purchases/orders/:id/discard', '/purchase-orders/:id/discard'], ...scoped, can('purchase.edit'), async (req, res) => {
    res.json(await orders.discard(ctx(req), id(req), meta(req)));
  });

  router.get(['/purchases/orders/:id/pdf', '/purchase-orders/:id/pdf'], ...scoped, can(['document.download', 'purchase.edit', 'purchase.issue']), async (req, res) => {
    const { bytes, filename } = await orders.pdf(ctx(req), id(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  });

  // -------------------------------------------------------------------------
  // Goods Receipts
  // -------------------------------------------------------------------------
  router.get(['/purchases/receipts', '/goods-receipts'], ...scoped, can(['receipt.post', 'purchase.edit', 'stock.view']), async (req, res) => {
    const query = purchaseDocListQuerySchema.parse(req.query);
    res.json(await receipts.list(ctx(req), query));
  });

  router.get(['/purchases/receipts/:id', '/goods-receipts/:id'], ...scoped, can(['receipt.post', 'purchase.edit', 'stock.view']), async (req, res) => {
    res.json(await receipts.getById(ctx(req), id(req)));
  });

  router.post(['/purchases/receipts', '/goods-receipts'], ...scoped, can(['receipt.post', 'stock.move', 'purchase.edit']), async (req, res) => {
    const input = createGoodsReceiptSchema.parse(req.body);
    res.status(201).json(await receipts.createDraft(ctx(req), input, meta(req)));
  });

  router.put(['/purchases/receipts/:id', '/goods-receipts/:id'], ...scoped, can(['receipt.post', 'stock.move', 'purchase.edit']), async (req, res) => {
    const input = createGoodsReceiptSchema.parse(req.body);
    res.json(await receipts.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.patch(['/purchases/receipts/:id', '/goods-receipts/:id'], ...scoped, can(['receipt.post', 'stock.move', 'purchase.edit']), async (req, res) => {
    const input = createGoodsReceiptSchema.parse(req.body);
    res.json(await receipts.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.post(['/purchases/receipts/:id/receive', '/goods-receipts/:id/receive'], ...scoped, can('receipt.post'), once, async (req, res) => {
    res.json(await receipts.receive(ctx(req), id(req), meta(req)));
  });

  router.post(['/purchases/receipts/:id/cancel', '/goods-receipts/:id/cancel'], ...scoped, can('receipt.post'), once, async (req, res) => {
    const body = cancelPurchaseDocCommandSchema.parse(req.body);
    res.json(await receipts.cancel(ctx(req), id(req), body.reason, meta(req)));
  });

  router.post(['/purchases/receipts/:id/discard', '/goods-receipts/:id/discard'], ...scoped, can(['receipt.post', 'stock.move', 'purchase.edit']), async (req, res) => {
    res.json(await receipts.discard(ctx(req), id(req), meta(req)));
  });

  // -------------------------------------------------------------------------
  // Supplier Bills
  // -------------------------------------------------------------------------
  router.get(['/purchases/bills', '/supplier-bills'], ...scoped, can(['bill.post', 'bill.cancel', 'report.financial', 'purchase.edit']), async (req, res) => {
    const query = purchaseDocListQuerySchema.parse(req.query);
    res.json(await bills.list(ctx(req), query));
  });

  router.get(['/purchases/bills/:id', '/supplier-bills/:id'], ...scoped, can(['bill.post', 'bill.cancel', 'report.financial', 'purchase.edit']), async (req, res) => {
    res.json(await bills.getById(ctx(req), id(req)));
  });

  router.post(['/purchases/bills', '/supplier-bills'], ...scoped, can(['bill.post', 'purchase.edit']), async (req, res) => {
    const input = createSupplierBillSchema.parse(req.body);
    res.status(201).json(await bills.createDraft(ctx(req), input, meta(req)));
  });

  router.put(['/purchases/bills/:id', '/supplier-bills/:id'], ...scoped, can(['bill.post', 'purchase.edit']), async (req, res) => {
    const input = createSupplierBillSchema.parse(req.body);
    res.json(await bills.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.patch(['/purchases/bills/:id', '/supplier-bills/:id'], ...scoped, can(['bill.post', 'purchase.edit']), async (req, res) => {
    const input = createSupplierBillSchema.parse(req.body);
    res.json(await bills.updateDraft(ctx(req), id(req), input, meta(req)));
  });

  router.post(['/purchases/bills/:id/post', '/supplier-bills/:id/post'], ...scoped, can('bill.post'), once, async (req, res) => {
    res.json(await bills.post(ctx(req), id(req), meta(req)));
  });

  router.post(['/purchases/bills/:id/cancel', '/supplier-bills/:id/cancel'], ...scoped, can('bill.cancel'), once, async (req, res) => {
    const body = cancelPurchaseDocCommandSchema.parse(req.body);
    res.json(await bills.cancel(ctx(req), id(req), body.reason, meta(req)));
  });

  router.post(['/purchases/bills/:id/discard', '/supplier-bills/:id/discard'], ...scoped, can(['bill.post', 'purchase.edit']), async (req, res) => {
    res.json(await bills.discard(ctx(req), id(req), meta(req)));
  });

  // -------------------------------------------------------------------------
  // Payables & Ageing
  // -------------------------------------------------------------------------
  router.get(['/purchases/payables', '/payables'], ...scoped, can('report.financial'), async (req, res) => {
    const query = payablesQuerySchema.parse(req.query);
    res.json(await payables(models, ctx(req), query, now?.() ?? new Date()));
  });

  return router;
}
