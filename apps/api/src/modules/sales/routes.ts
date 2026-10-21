import { Router, type Request, type Response } from 'express';
import {
  dispatchInputSchema,
  dispatchUpdateSchema,
  invoiceIssueSchema,
  objectIdSchema,
  orderConfirmSchema,
  quotationConvertSchema,
  quotationInputSchema,
  quotationUpdateSchema,
  reasonCommandSchema,
  receivablesQuerySchema,
  salesCommandSchema,
  salesDocListQuerySchema,
  salesInvoiceInputSchema,
  salesInvoiceUpdateSchema,
  salesOrderInputSchema,
  salesOrderUpdateSchema,
  type Permission,
  type SalesDocType,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { idempotent } from '../../platform/idempotency.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import { VIEW_PERMISSIONS, type SalesCore } from './core.js';
import type { DispatchService } from './dispatches.js';
import type { SalesInvoiceService } from './invoices.js';
import type { SalesOrderService } from './orders.js';
import type { QuotationService } from './quotations.js';
import { receivables } from './receivables.js';

interface Deps {
  config: AppConfig;
  models: Models;
  now?: (() => Date) | undefined;
  identity: IdentityService;
  tenancy: TenancyService;
  core: SalesCore;
  quotations: QuotationService;
  orders: SalesOrderService;
  dispatches: DispatchService;
  invoices: SalesInvoiceService;
}

/**
 * Order-to-cash routes (api-conventions.md, Phase 7). Route guards check that
 * the permission is held somewhere; services check it for the business entity
 * (and warehouse, for stock) of the document (FR-RBAC-03).
 *
 * Commands that number a document or move stock or money need an
 * Idempotency-Key: a retry with the same key replays the first response.
 */
export function salesRouter({ config, models, now, identity, tenancy, core, quotations, orders, dispatches, invoices }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const version = (req: Request) => salesCommandSchema.parse(req.body).version;
  const can = (permissions: Permission | Permission[]) => requirePermission(permissions, config);
  const once = idempotent(models, now);

  const sendPdf = async (req: Request, res: Response, docType: SalesDocType) => {
    const { bytes, filename } = await core.pdf(ctx(req), docType, id(req));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  };
  const list = (path: string, docType: SalesDocType) => {
    router.get(path, ...scoped, can(VIEW_PERMISSIONS[docType]), async (req, res) => {
      res.json(await core.list(ctx(req), docType, salesDocListQuerySchema.parse(req.query)));
    });
  };

  // Quotations and proforma invoices
  list('/quotations', 'quotation');
  router.get('/quotations/:id', ...scoped, can(VIEW_PERMISSIONS.quotation), async (req, res) => {
    res.json(await quotations.get(ctx(req), id(req)));
  });
  router.post('/quotations', ...scoped, can('quotation.edit'), async (req, res) => {
    res.status(201).json(await quotations.create(ctx(req), quotationInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/quotations/:id', ...scoped, can('quotation.edit'), async (req, res) => {
    res.json(await quotations.update(ctx(req), id(req), quotationUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/quotations/:id/send', ...scoped, can('quotation.issue'), once, async (req, res) => {
    res.json(await quotations.send(ctx(req), id(req), version(req), meta(req)));
  });
  for (const action of ['accept', 'reject', 'discard'] as const) {
    router.post(`/quotations/:id/${action}`, ...scoped, can('quotation.edit'), async (req, res) => {
      res.json(await quotations.decide(ctx(req), id(req), action, version(req), meta(req)));
    });
  }
  router.post('/quotations/:id/revise', ...scoped, can('quotation.edit'), async (req, res) => {
    res.status(201).json(await quotations.revise(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/quotations/:id/convert', ...scoped, can('quotation.edit'), async (req, res) => {
    res.status(201).json(await quotations.convert(ctx(req), id(req), quotationConvertSchema.parse(req.body), meta(req)));
  });
  router.get('/quotations/:id/pdf', ...scoped, can('document.download'), async (req, res) => sendPdf(req, res, 'quotation'));

  // Sales orders
  list('/sales-orders', 'sales_order');
  router.get('/sales-orders/:id', ...scoped, can(VIEW_PERMISSIONS.sales_order), async (req, res) => {
    res.json(await orders.get(ctx(req), id(req)));
  });
  router.post('/sales-orders', ...scoped, can('salesorder.edit'), async (req, res) => {
    res.status(201).json(await orders.create(ctx(req), salesOrderInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/sales-orders/:id', ...scoped, can('salesorder.edit'), async (req, res) => {
    res.json(await orders.update(ctx(req), id(req), salesOrderUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/sales-orders/:id/confirm', ...scoped, can('salesorder.confirm'), once, async (req, res) => {
    res.json(await orders.confirm(ctx(req), id(req), orderConfirmSchema.parse(req.body), meta(req)));
  });
  for (const action of ['cancel', 'close'] as const) {
    router.post(`/sales-orders/:id/${action}`, ...scoped, can('salesorder.cancel'), once, async (req, res) => {
      res.json(await orders.end(ctx(req), id(req), action, reasonCommandSchema.parse(req.body), meta(req)));
    });
  }
  router.post('/sales-orders/:id/discard', ...scoped, can('salesorder.edit'), async (req, res) => {
    res.json(await orders.discard(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/sales-orders/:id/dispatches', ...scoped, can('dispatch.post'), async (req, res) => {
    res.status(201).json(await orders.makeDispatch(ctx(req), id(req), meta(req)));
  });
  router.post('/sales-orders/:id/invoices', ...scoped, can('invoice.edit'), async (req, res) => {
    res.status(201).json(await orders.makeInvoice(ctx(req), id(req), meta(req)));
  });

  // Dispatches (delivery challans)
  list('/dispatches', 'dispatch');
  router.get('/dispatches/:id', ...scoped, can(VIEW_PERMISSIONS.dispatch), async (req, res) => {
    res.json(await dispatches.get(ctx(req), id(req)));
  });
  router.post('/dispatches', ...scoped, can('dispatch.post'), async (req, res) => {
    res.status(201).json(await dispatches.create(ctx(req), dispatchInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/dispatches/:id', ...scoped, can('dispatch.post'), async (req, res) => {
    res.json(await dispatches.update(ctx(req), id(req), dispatchUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/dispatches/:id/dispatch', ...scoped, can('dispatch.post'), once, async (req, res) => {
    res.json(await dispatches.dispatch(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/dispatches/:id/cancel', ...scoped, can('dispatch.post'), once, async (req, res) => {
    res.json(await dispatches.cancel(ctx(req), id(req), reasonCommandSchema.parse(req.body), meta(req)));
  });
  router.post('/dispatches/:id/discard', ...scoped, can('dispatch.post'), async (req, res) => {
    res.json(await dispatches.discard(ctx(req), id(req), version(req), meta(req)));
  });
  router.post('/dispatches/:id/invoices', ...scoped, can('invoice.edit'), async (req, res) => {
    res.status(201).json(await dispatches.makeInvoice(ctx(req), id(req), meta(req)));
  });
  router.get('/dispatches/:id/pdf', ...scoped, can('document.download'), async (req, res) => sendPdf(req, res, 'dispatch'));

  // Tax invoices and bills of supply
  list('/sales-invoices', 'sales_invoice');
  router.get('/sales-invoices/:id', ...scoped, can(VIEW_PERMISSIONS.sales_invoice), async (req, res) => {
    res.json(await invoices.get(ctx(req), id(req)));
  });
  router.post('/sales-invoices', ...scoped, can('invoice.edit'), async (req, res) => {
    res.status(201).json(await invoices.create(ctx(req), salesInvoiceInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/sales-invoices/:id', ...scoped, can('invoice.edit'), async (req, res) => {
    res.json(await invoices.update(ctx(req), id(req), salesInvoiceUpdateSchema.parse(req.body), meta(req)));
  });
  router.post('/sales-invoices/:id/issue', ...scoped, can('invoice.issue'), once, async (req, res) => {
    res.json(await invoices.issue(ctx(req), id(req), invoiceIssueSchema.parse(req.body), meta(req)));
  });
  router.post('/sales-invoices/:id/cancel', ...scoped, can('invoice.cancel'), once, async (req, res) => {
    res.json(await invoices.cancel(ctx(req), id(req), reasonCommandSchema.parse(req.body), meta(req)));
  });
  router.post('/sales-invoices/:id/discard', ...scoped, can('invoice.edit'), async (req, res) => {
    res.json(await invoices.discard(ctx(req), id(req), version(req), meta(req)));
  });
  router.get('/sales-invoices/:id/pdf', ...scoped, can('document.download'), async (req, res) => sendPdf(req, res, 'sales_invoice'));

  router.get('/receivables', ...scoped, can(['report.sales', 'report.financial']), async (req, res) => {
    res.json(await receivables(models, ctx(req), receivablesQuerySchema.parse(req.query), now?.() ?? new Date()));
  });

  return router;
}
