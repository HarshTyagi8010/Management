import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { Types } from 'mongoose';
import { objectIdSchema, STEP_UP_PERMISSIONS, type Permission } from '@bizmgmt/contracts';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { hmac, randomToken, safeEqual, type Keyring } from '../platform/crypto.js';
import { STEP_UP_WINDOW_MS, type Authenticated, type IdentityService, type RequestMeta } from '../modules/identity/identity.js';
import type { TenancyService, TenantContext } from '../modules/tenancy/tenancy.js';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: Authenticated;
    tenant?: TenantContext;
  }
}

/** `__Host-` cookies must be Secure, Path=/ and have no Domain, so they cannot be set or read by sibling subdomains. */
export const SESSION_COOKIE = '__Host-sid';
export const CSRF_COOKIE = '__Host-csrf';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

const cookieOptions = (maxAgeMs?: number): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
  ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
});

export function setSessionCookie(res: Response, token: string, absoluteExpiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(Math.max(1000, absoluteExpiresAt.getTime() - Date.now())));
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

export function requestMeta(req: Request, identity: IdentityService): RequestMeta {
  return {
    ipHash: identity.lookupHash('ip', req.ip ?? 'unknown'),
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    requestId: String(req.id ?? ''),
  };
}

/** Resolves the session cookie into `req.auth`. Invalid or expired cookies are cleared. */
export function sessionMiddleware(identity: IdentityService): RequestHandler {
  return async (req, res, next) => {
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (token) {
      const auth = await identity.resolveSession(token);
      if (auth) req.auth = auth;
      else clearSessionCookie(res);
    }
    next();
  };
}

/**
 * CSRF tokens are HMACs over what the request is bound to: the session id when
 * signed in, otherwise a random pre-session cookie (protects sign-in and sign-up
 * against login CSRF). Tokens are never stored; they are recomputed per request.
 */
export class Csrf {
  constructor(private readonly keys: Keyring) {}

  tokenForSession(sessionId: Types.ObjectId): string {
    return hmac(this.keys.csrf, `sid:${sessionId.toHexString()}`);
  }

  /** Returns the anonymous token, setting the pre-session cookie if the request does not have one. */
  anonymousToken(req: Request, res: Response): string {
    let seed = parseCookies(req.headers.cookie).get(CSRF_COOKIE);
    if (!seed || !/^[A-Za-z0-9_-]{43}$/.test(seed)) {
      seed = randomToken();
      res.cookie(CSRF_COOKIE, seed, cookieOptions());
    }
    return hmac(this.keys.csrf, `anon:${seed}`);
  }

  private expected(req: Request): string | undefined {
    if (req.auth) return this.tokenForSession(req.auth.session._id);
    const seed = parseCookies(req.headers.cookie).get(CSRF_COOKIE);
    return seed ? hmac(this.keys.csrf, `anon:${seed}`) : undefined;
  }

  /** Enforced on every unsafe method (AC-AUTH-3), plus Origin and Fetch-Metadata checks. */
  middleware(config: AppConfig): RequestHandler {
    const allowedOrigins = new Set(config.corsOrigins);
    return (req, _res, next) => {
      if (!UNSAFE_METHODS.has(req.method)) return next();
      const fail = () => next(new AppError('CSRF_INVALID', 'The request could not be verified. Reload the page and try again.'));
      if (req.headers['sec-fetch-site'] === 'cross-site') return fail();
      const origin = req.headers.origin;
      if (origin && origin !== `${req.protocol}://${req.get('host') ?? ''}` && !allowedOrigins.has(origin)) return fail();
      const sent = req.headers['x-csrf-token'];
      const expected = this.expected(req);
      if (typeof sent !== 'string' || !expected || !safeEqual(sent, expected)) return fail();
      next();
    };
  }
}

/** Requires a fully signed-in session (password and, when enabled, MFA). */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
  if (req.auth.session.mfaState !== 'complete') return next(new AppError('MFA_REQUIRED', 'Enter your two-step verification code to finish signing in'));
  next();
};

/**
 * Validates `X-Tenant-Id` against the caller's memberships and attaches the
 * tenant context. Not a member (or tenant missing) → 404, so tenant ids cannot be probed.
 */
export function tenantContext(tenancy: TenancyService): RequestHandler {
  return async (req, _res, next) => {
    if (!req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
    const header = req.headers['x-tenant-id'];
    const parsed = objectIdSchema.safeParse(header);
    if (!parsed.success) return next(new AppError('BAD_REQUEST', 'X-Tenant-Id header is missing or invalid'));
    const ctx = await tenancy.loadContext(req.auth.user._id, new Types.ObjectId(parsed.data));
    if (!ctx) return next(new AppError('NOT_FOUND', 'Business not found'));
    req.tenant = ctx;
    next();
  };
}

export function stepUpSatisfied(auth: Authenticated, mfaEnforcement: AppConfig['mfaEnforcement'], now = new Date()): 'ok' | 'verify' | 'enrol' {
  if (auth.user.mfaEnabled) {
    const at = auth.session.mfaVerifiedAt?.getTime() ?? 0;
    return now.getTime() - at <= STEP_UP_WINDOW_MS ? 'ok' : 'verify';
  }
  return mfaEnforcement === 'privileged' ? 'enrol' : 'ok';
}

/**
 * Server-side permission check (NFR-SEC-02); the caller needs any one of the listed permissions.
 * Changes guarded by a step-up permission also need a recent MFA verification; reads opt out with `stepUp: false`.
 */
export function requirePermission(permissions: Permission | Permission[], config: AppConfig, options: { stepUp?: boolean | undefined; now?: (() => Date) | undefined } = {}): RequestHandler {
  const list = Array.isArray(permissions) ? permissions : [permissions];
  const stepUp = options.stepUp ?? list.some((p) => STEP_UP_PERMISSIONS.includes(p));
  return (req, _res, next) => {
    if (!req.tenant || !req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
    const tenant = req.tenant;
    if (!list.some((p) => tenant.permissions.has(p))) return next(new AppError('FORBIDDEN', "You don't have permission to do this"));
    if (stepUp) {
      const state = stepUpSatisfied(req.auth, config.mfaEnforcement, options.now?.());
      if (state === 'verify') return next(new AppError('MFA_REQUIRED', 'Confirm it’s you with your authenticator code', [{ path: 'mfa', message: 'step_up' }]));
      if (state === 'enrol') return next(new AppError('MFA_REQUIRED', 'Turn on two-step verification to use this feature', [{ path: 'mfa', message: 'enrolment_required' }]));
    }
    next();
  };
}
