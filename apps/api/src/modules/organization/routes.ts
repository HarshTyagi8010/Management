import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  bankAccountsUpdateSchema,
  gstRegistrationInputSchema,
  gstRegistrationUpdateSchema,
  legalEntityInputSchema,
  legalEntityUpdateSchema,
  logoUpdateSchema,
  objectIdSchema,
  periodLockUpdateSchema,
  seriesInputSchema,
  seriesUpdateSchema,
  workflowUpdateSchema,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { requestMeta, requireAuth, requirePermission, stepUpSatisfied, tenantContext } from '../../middleware/auth.js';
import type { IdentityService } from '../identity/identity.js';
import type { TenancyService, TenantContext } from '../tenancy/tenancy.js';
import type { OrganizationService } from './organization.js';

interface Deps {
  config: AppConfig;
  identity: IdentityService;
  tenancy: TenancyService;
  organization: OrganizationService;
}

/**
 * Company settings. Route guards check the permission exists in some entity;
 * the service then checks it for the specific legal entity (FR-RBAC-03).
 */
export function organizationRouter({ config, identity, tenancy, organization }: Deps): Router {
  const router = Router();
  const scoped = [requireAuth, tenantContext(tenancy)];
  const meta = (req: Request) => requestMeta(req, identity);
  const ctx = (req: Request): TenantContext => {
    if (!req.tenant) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.tenant;
  };
  const id = (req: Request) => objectIdSchema.parse(req.params.id);
  const company = requirePermission('settings.company', config);

  // Any member can read the entities they work in (documents print the seller's details).
  router.get('/legal-entities', ...scoped, async (req, res) => {
    res.json({ data: await organization.listEntities(ctx(req)) });
  });
  router.post('/legal-entities', ...scoped, company, async (req, res) => {
    res.status(201).json(await organization.createEntity(ctx(req), legalEntityInputSchema.parse(req.body), meta(req)));
  });
  router.get('/legal-entities/:id', ...scoped, async (req, res) => {
    res.json(await organization.getEntity(ctx(req), id(req)));
  });
  router.patch('/legal-entities/:id', ...scoped, company, async (req, res) => {
    res.json(await organization.updateEntity(ctx(req), id(req), legalEntityUpdateSchema.parse(req.body), meta(req)));
  });
  router.put('/legal-entities/:id/workflow', ...scoped, requirePermission('settings.workflow', config), async (req, res) => {
    res.json(await organization.updateWorkflow(ctx(req), id(req), workflowUpdateSchema.parse(req.body), meta(req)));
  });
  router.put('/legal-entities/:id/bank-accounts', ...scoped, company, async (req, res) => {
    res.json(await organization.updateBankAccounts(ctx(req), id(req), bankAccountsUpdateSchema.parse(req.body), meta(req)));
  });
  // The image travels as base64 inside JSON, so the API's JSON-only rule and body limit apply unchanged.
  router.put('/legal-entities/:id/logo', ...scoped, company, async (req, res) => {
    res.json(await organization.updateLogo(ctx(req), id(req), logoUpdateSchema.parse(req.body), meta(req)));
  });

  router.put('/legal-entities/:id/period-lock', ...scoped, requirePermission(['period.lock', 'period.unlock'], config, { stepUp: false }), async (req, res) => {
    const input = periodLockUpdateSchema.parse(req.body);
    // Moving a lock back reopens closed books: it needs a recent two-step verification (permission-matrix: period.unlock).
    if ((await organization.periodLockDirection(ctx(req), id(req), input.lockDate)) === 'backward' && req.auth) {
      const state = stepUpSatisfied(req.auth, config.mfaEnforcement);
      if (state === 'verify') throw new AppError('MFA_REQUIRED', 'Confirm it’s you with your authenticator code', [{ path: 'mfa', message: 'step_up' }]);
      if (state === 'enrol') throw new AppError('MFA_REQUIRED', 'Turn on two-step verification to use this feature', [{ path: 'mfa', message: 'enrolment_required' }]);
    }
    res.json(await organization.updatePeriodLock(ctx(req), id(req), input, meta(req)));
  });

  router.get('/legal-entities/:id/registrations', ...scoped, async (req, res) => {
    res.json({ data: await organization.listRegistrations(ctx(req), id(req)) });
  });
  router.post('/legal-entities/:id/registrations', ...scoped, company, async (req, res) => {
    res.status(201).json(await organization.createRegistration(ctx(req), id(req), gstRegistrationInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/gst-registrations/:id', ...scoped, company, async (req, res) => {
    res.json(await organization.updateRegistration(ctx(req), id(req), gstRegistrationUpdateSchema.parse(req.body), meta(req)));
  });

  router.get('/document-series', ...scoped, requirePermission(['settings.view', 'settings.company'], config), async (req, res) => {
    const { legalEntityId } = z.strictObject({ legalEntityId: objectIdSchema }).parse(req.query);
    res.json({ data: await organization.listSeries(ctx(req), legalEntityId) });
  });
  router.post('/document-series', ...scoped, company, async (req, res) => {
    res.status(201).json(await organization.createSeries(ctx(req), seriesInputSchema.parse(req.body), meta(req)));
  });
  router.patch('/document-series/:id', ...scoped, company, async (req, res) => {
    res.json(await organization.updateSeries(ctx(req), id(req), seriesUpdateSchema.parse(req.body), meta(req)));
  });

  return router;
}
