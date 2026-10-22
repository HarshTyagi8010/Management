import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  businessDateSchema,
  calcPreviewRequestSchema,
  financialReconciliationQuerySchema,
  journalListQuerySchema,
  objectIdSchema,
  type IntegrityCheck,
} from '@bizmgmt/contracts';
import { Types } from 'mongoose';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { todayIST } from '../../platform/values.js';
import type { IdentityService } from '../identity/identity.js';
import { canInEntity, type TenancyService, type TenantContext } from '../tenancy/tenancy.js';
import type { JournalService } from './journals.js';
import type { PreviewService } from './preview.js';
import type { ReconciliationService } from './reconciliation.js';

import type { ComplianceService } from './compliance.js';
import { periodCloseExecuteRequestSchema } from '@bizmgmt/contracts';

interface Deps {
  config: AppConfig;
  models: Models;
  identity?: IdentityService | undefined;
  tenancy: TenancyService;
  journals: JournalService;
  preview: PreviewService;
  reconciliation: ReconciliationService;
  compliance: ComplianceService;
  now?: (() => Date) | undefined;
}

/** Calculation preview, books (accounts, journals, trial balance) and integrity check results. */
export function financeRouter({ config, models, identity, tenancy, journals, preview, reconciliation, compliance, now }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => (identity ? requestMeta(req, identity) : undefined);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const financial = requirePermission('report.financial', config);
  const csvExport = requirePermission('export.csv', config);
  const periodLock = requirePermission('period.lock', config);

  /** The books of an entity: report.financial in that entity, otherwise "not found". */
  const entityFor = async (req: Request, raw: unknown, permission: any = 'report.financial') => {
    const id = objectIdSchema.parse(raw);
    if (!canInEntity(ctx(req), permission, id)) throw new AppError('NOT_FOUND', 'Business entity not found');
    if (!(await models.LegalEntity.exists({ tenantId: ctx(req).tenantId, _id: new Types.ObjectId(id) }))) throw new AppError('NOT_FOUND', 'Business entity not found');
    return new Types.ObjectId(id);
  };

  // Anyone who prepares sales or purchase documents can ask for figures; the server computes them.
  router.post('/calc/preview', ...scoped, requirePermission(['invoice.edit', 'quotation.edit', 'salesorder.edit', 'purchase.edit'], config), async (req, res) => {
    res.json(await preview.preview(ctx(req), calcPreviewRequestSchema.parse(req.body)));
  });

  router.get('/accounts', ...scoped, financial, async (req, res) => {
    const entityId = await entityFor(req, req.query.legalEntityId);
    res.json({ data: await journals.listAccounts(ctx(req).tenantId, entityId) });
  });

  router.get('/journals', ...scoped, financial, async (req, res) => {
    let legalEntityId = req.query.legalEntityId as string | undefined;
    const sourceId = req.query.sourceId as string | undefined;
    if (!legalEntityId && sourceId) {
      const j = await models.Journal.findOne({ tenantId: ctx(req).tenantId, sourceId: new Types.ObjectId(sourceId) }).lean();
      if (j) legalEntityId = j.legalEntityId.toHexString();
    }
    if (!legalEntityId) throw new AppError('VALIDATION_FAILED', 'legalEntityId is required');
    await entityFor(req, legalEntityId);
    const query = journalListQuerySchema.parse({ ...req.query, legalEntityId });
    res.json(await journals.listJournals(ctx(req).tenantId, query as any));
  });

  router.get('/reports/trial-balance', ...scoped, financial, async (req, res) => {
    const query = z.strictObject({ legalEntityId: objectIdSchema, asOf: businessDateSchema.optional() }).parse(req.query);
    const entityId = await entityFor(req, query.legalEntityId);
    res.json(await journals.trialBalance(ctx(req).tenantId, entityId, query.asOf ?? todayIST(now?.())));
  });

  // Latest results of the scheduled checks (worker), so drift is visible without running a check by hand.
  router.get('/integrity-checks', ...scoped, requirePermission(['stock.adjust', 'report.financial'], config), async (req, res) => {
    const rows = await models.IntegrityCheck.find({ tenantId: ctx(req).tenantId }).sort({ kind: 1 }).lean();
    const data: IntegrityCheck[] = rows.map((r) => ({ kind: r.kind, checkedAt: r.checkedAt.toISOString(), ok: r.ok, issueCount: r.issueCount, summary: r.summary }));
    res.json({ data });
  });

  // Authoritative financial reconciliation (Batch B)
  router.get('/reconciliation/financial', ...scoped, financial, async (req, res, next) => {
    try {
      const query = financialReconciliationQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await reconciliation.reconcileFinancial(ctx(req).tenantId, query));
    } catch (err) {
      console.error('RECONCILIATION ROUTE ERROR:', err);
      next(err);
    }
  });

  // ------------------------------------------------------------ Compliance & Statutory Preparation (Batch C)
  router.get('/compliance/capabilities', ...scoped, async (_req, res) => {
    res.json(compliance.getCapabilities());
  });

  const periodQuerySchema = z.strictObject({
    legalEntityId: objectIdSchema,
    fromDate: businessDateSchema,
    toDate: businessDateSchema,
    gstRegistrationId: objectIdSchema.optional(),
  });

  router.get('/compliance/outward-register', ...scoped, financial, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await compliance.getOutwardRegister(ctx(req), query));
    } catch (err) {
      console.error('OUTWARD REGISTER ROUTE ERROR:', err);
      next(err);
    }
  });


  router.get('/compliance/outward-register/export', ...scoped, financial, csvExport, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      const report = await compliance.getOutwardRegister(ctx(req), query);
      const csv = compliance.exportOutwardRegisterCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="outward-register-${query.fromDate}-${query.toDate}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/purchase-register', ...scoped, financial, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await compliance.getPurchaseRegister(ctx(req), query));
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/purchase-register/export', ...scoped, financial, csvExport, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      const report = await compliance.getPurchaseRegister(ctx(req), query);
      const csv = compliance.exportPurchaseRegisterCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="purchase-register-${query.fromDate}-${query.toDate}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/hsn-summary', ...scoped, financial, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await compliance.getHsnSummary(ctx(req), query));
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/hsn-summary/export', ...scoped, financial, csvExport, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      const report = await compliance.getHsnSummary(ctx(req), query);
      const csv = compliance.exportHsnSummaryCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="hsn-summary-${query.fromDate}-${query.toDate}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/document-summary', ...scoped, financial, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await compliance.getDocumentSummary(ctx(req), query));
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/document-summary/export', ...scoped, financial, csvExport, async (req, res, next) => {
    try {
      const query = periodQuerySchema.parse(req.query);
      await entityFor(req, query.legalEntityId);
      const report = await compliance.getDocumentSummary(ctx(req), query);
      const csv = compliance.exportDocumentSummaryCsv(report);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="document-summary-${query.fromDate}-${query.toDate}.csv"`);
      res.send(csv);
    } catch (err) {
      next(err);
    }
  });

  router.get('/compliance/period-close/checklist', ...scoped, financial, async (req, res, next) => {
    try {
      const query = z.strictObject({
        legalEntityId: objectIdSchema,
        periodEndDate: businessDateSchema,
        mode: z.enum(['reconciled_close', 'administrative_lock']).optional(),
      }).parse(req.query);
      await entityFor(req, query.legalEntityId);
      res.json(await compliance.getPeriodCloseChecklist(ctx(req), query));
    } catch (err) {
      next(err);
    }
  });

  router.post('/compliance/period-close/execute', ...scoped, periodLock, async (req, res, next) => {
    try {
      const body = periodCloseExecuteRequestSchema.parse(req.body);
      await entityFor(req, body.legalEntityId, 'period.lock');
      res.json(await compliance.executePeriodClose(ctx(req), body, meta(req)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

