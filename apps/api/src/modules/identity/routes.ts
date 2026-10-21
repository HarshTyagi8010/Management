import { Router, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import {
  activeTenantRequestSchema,
  invitationAcceptRequestSchema,
  invitationInspectRequestSchema,
  loginRequestSchema,
  mfaVerifyRequestSchema,
  objectIdSchema,
  passwordChangeRequestSchema,
  passwordForgotRequestSchema,
  passwordResetRequestSchema,
  preferencesRequestSchema,
  signupRequestSchema,
  totpConfirmRequestSchema,
  type MfaEnabledResponse,
  type SessionResponse,
} from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import { clearSessionCookie, requestMeta, requireAuth, setSessionCookie, type Csrf } from '../../middleware/auth.js';
import type { Models, SessionDoc } from '../../models.js';
import { POLICIES, type Throttle } from '../../platform/rate-limit.js';
import { withTransaction } from '../../platform/transactions.js';
import type { Connection } from 'mongoose';
import type { TenancyService } from '../tenancy/tenancy.js';
import type { CatalogueService } from '../catalogue/catalogue.js';
import { rateLimited, type Authenticated, type IdentityService } from './identity.js';

interface Deps {
  config: AppConfig;
  connection: Connection;
  models: Models;
  identity: IdentityService;
  tenancy: TenancyService;
  catalogue: CatalogueService;
  csrf: Csrf;
  throttle: Throttle;
}

/** Routes under /api/v1/auth: sign-up, sign-in, MFA, passwords, own sessions and preferences. */
export function authRouter({ config, connection, models, identity, tenancy, catalogue, csrf, throttle }: Deps): Router {
  const router = Router();
  const meta = (req: Request) => requestMeta(req, identity);
  const auth = (req: Request): Authenticated => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    return req.auth;
  };

  async function view(session: SessionDoc): Promise<SessionResponse> {
    const csrfToken = csrf.tokenForSession(session._id);
    if (session.mfaState === 'pending') return { status: 'mfa_required', csrfToken };
    const user = await models.User.findById(session.userId).lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue');
    const tenants = await tenancy.listTenantsForUser(user._id);
    const active = tenants.find((t) => t.id === user.lastTenantId?.toHexString()) ?? tenants[0] ?? null;
    return { status: 'authenticated', csrfToken, user: identity.toSessionUser(user), tenants, activeTenantId: active?.id ?? null };
  }

  async function respondWithSession(res: Response, created: { token: string; session: SessionDoc }, status = 200) {
    setSessionCookie(res, created.token, created.session.absoluteExpiresAt);
    res.status(status).json(await view(created.session));
  }

  /** Per-IP limit for unauthenticated endpoints that do not have their own policy. */
  async function limitByIp(req: Request, prefix: string, policy: (typeof POLICIES)[keyof typeof POLICIES]) {
    const key = `${prefix}:${meta(req).ipHash}`;
    const blocked = await throttle.blockedFor(key);
    if (blocked > 0) throw rateLimited(blocked);
    await throttle.hit(key, policy);
  }

  router.get('/auth/session', async (req, res) => {
    if (req.auth) {
      res.json(await view(req.auth.session));
      return;
    }
    const body: SessionResponse = { status: 'anonymous', csrfToken: csrf.anonymousToken(req, res) };
    res.json(body);
  });

  router.post('/auth/signup', async (req, res) => {
    if (!config.signupEnabled) throw new AppError('FORBIDDEN', 'New sign-ups are closed on this installation. Ask an administrator for an invitation.');
    await limitByIp(req, 'signup-ip', POLICIES.signupIp);
    const input = signupRequestSchema.parse(req.body);
    const m = meta(req);
    const userId = await withTransaction(connection, async (s) => {
      const tenantPlaceholder = new Types.ObjectId();
      const user = await identity.createUser({ name: input.name, email: input.email, password: input.password, emailVerified: false, lastTenantId: tenantPlaceholder }, s);
      const tenantId = await tenancy.createTenantWithOwner(user._id, input.businessName, m, s);
      await catalogue.seedUnits(tenantId, s);
      await models.User.updateOne({ _id: user._id }, { $set: { lastTenantId: tenantId } }, { session: s });
      return user._id;
    });
    if (req.auth) await identity.revokeSession(req.auth.session._id);
    await respondWithSession(res, await identity.startSession(userId, m), 201);
  });

  router.post('/auth/login', async (req, res) => {
    const input = loginRequestSchema.parse(req.body);
    await respondWithSession(res, await identity.login(input.email, input.password, meta(req), req.auth?.session));
  });

  router.post('/auth/logout', async (req, res) => {
    if (req.auth) await identity.logout(req.auth, meta(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.post('/auth/logout-all', requireAuth, async (req, res) => {
    await identity.logoutAll(auth(req), meta(req));
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.post('/auth/mfa/verify', async (req, res) => {
    const { code } = mfaVerifyRequestSchema.parse(req.body);
    await respondWithSession(res, await identity.verifyPendingMfa(auth(req), code, meta(req)));
  });

  router.post('/auth/mfa/step-up', requireAuth, async (req, res) => {
    const { code } = mfaVerifyRequestSchema.parse(req.body);
    await respondWithSession(res, await identity.stepUp(auth(req), code, meta(req)));
  });

  router.post('/auth/mfa/totp/setup', requireAuth, async (req, res) => {
    res.json(await identity.startTotpSetup(auth(req)));
  });

  router.post('/auth/mfa/totp/confirm', requireAuth, async (req, res) => {
    const { code } = totpConfirmRequestSchema.parse(req.body);
    const { recoveryCodes, ...created } = await identity.confirmTotpSetup(auth(req), code, meta(req));
    setSessionCookie(res, created.token, created.session.absoluteExpiresAt);
    const body: MfaEnabledResponse = { recoveryCodes, session: await view(created.session) };
    res.json(body);
  });

  router.post('/auth/mfa/disable', requireAuth, async (req, res) => {
    const { code } = mfaVerifyRequestSchema.parse(req.body);
    await respondWithSession(res, await identity.disableMfa(auth(req), code, meta(req)));
  });

  router.post('/auth/password/change', requireAuth, async (req, res) => {
    const input = passwordChangeRequestSchema.parse(req.body);
    await respondWithSession(res, await identity.changePassword(auth(req), input.currentPassword, input.newPassword, meta(req)));
  });

  router.post('/auth/password/forgot', async (req, res) => {
    const { email } = passwordForgotRequestSchema.parse(req.body);
    await identity.requestPasswordReset(email, meta(req));
    res.status(202).json({ status: 'accepted' });
  });

  router.post('/auth/password/reset', async (req, res) => {
    await limitByIp(req, 'reset-submit-ip', POLICIES.resetIp);
    const input = passwordResetRequestSchema.parse(req.body);
    await identity.resetPassword(input.token, input.newPassword, meta(req));
    if (req.auth) clearSessionCookie(res);
    res.status(204).end();
  });

  router.get('/auth/sessions', requireAuth, async (req, res) => {
    res.json({ data: await identity.listSessions(auth(req)) });
  });

  router.delete('/auth/sessions/:id', requireAuth, async (req, res) => {
    const id = objectIdSchema.parse(req.params.id);
    const current = auth(req);
    await identity.revokeOwnSession(current, id, meta(req));
    if (current.session._id.toHexString() === id) clearSessionCookie(res);
    res.status(204).end();
  });

  router.patch('/auth/preferences', requireAuth, async (req, res) => {
    await identity.setPreferences(auth(req), preferencesRequestSchema.parse(req.body));
    res.status(204).end();
  });

  router.put('/auth/active-tenant', requireAuth, async (req, res) => {
    const { tenantId } = activeTenantRequestSchema.parse(req.body);
    const current = auth(req);
    const ctx = await tenancy.loadContext(current.user._id, new Types.ObjectId(tenantId));
    if (!ctx) throw new AppError('NOT_FOUND', 'Business not found');
    await identity.setLastTenant(current.user._id, ctx.tenantId);
    res.status(204).end();
  });

  router.post('/auth/invitations/inspect', async (req, res) => {
    await limitByIp(req, 'invite-ip', POLICIES.invitationIp);
    const { token } = invitationInspectRequestSchema.parse(req.body);
    res.json(await tenancy.inspectInvitation(token));
  });

  router.post('/auth/invitations/accept', async (req, res) => {
    await limitByIp(req, 'invite-ip', POLICIES.invitationIp);
    const input = invitationAcceptRequestSchema.parse(req.body);
    const m = meta(req);
    const result = await tenancy.acceptInvitation(input.token, req.auth, input, m);
    if (result.newAccount) {
      if (req.auth) await identity.revokeSession(req.auth.session._id);
      await respondWithSession(res, await identity.startSession(result.userId, m), 201);
      return;
    }
    res.json(await view(auth(req).session));
  });

  return router;
}
