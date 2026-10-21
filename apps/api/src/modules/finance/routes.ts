import { Router, type Request } from 'express';
import { z } from 'zod';
import { businessDateSchema, calcPreviewRequestSchema, journalListQuerySchema, objectIdSchema, type IntegrityCheck } from '@bizmgmt/contracts';
import { Types } from 'mongoose';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requireAuth, requirePermission, tenantContext } from '../../middleware/auth.js';
import type { Models } from '../../models.js';
import { todayIST } from '../../platform/values.js';
import { canInEntity, type TenancyService, type TenantContext } from '../tenancy/tenancy.js';
import type { JournalService } from './journals.js';
import type { PreviewService } from './preview.js';

interface Deps {
  config: AppConfig;
  models: Models;
  tenancy: TenancyService;
  journals: JournalService;
  preview: PreviewService;
  now?: (() => Date) | undefined;
}

/** Calculation preview, books (accounts, journals, trial balance) and integrity check results. */
export function financeRouter({ config, models, tenancy, journals, preview, now }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const financial = requirePermission('report.financial', config);
  /** The books of an entity: report.financial in that entity, otherwise "not found". */
  const entityFor = async (req: Request, raw: unknown) => {
    const id = objectIdSchema.parse(raw);
    if (!canInEntity(ctx(req), 'report.financial', id)) throw new AppError('NOT_FOUND', 'Business entity not found');
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

  return router;
}
