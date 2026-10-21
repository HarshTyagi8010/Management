import { trusted, Types, type ClientSession, type Connection } from 'mongoose';
import type { Logger } from 'pino';
import type { OwnSession, SessionUser, ThemePreference } from '@bizmgmt/contracts';
import type { AppConfig } from '../../config.js';
import { AppError } from '../../errors.js';
import type { Models, SessionDoc, UserDoc } from '../../models.js';
import { decrypt, encrypt, hmac, randomToken, sha256, type Keyring } from '../../platform/crypto.js';
import type { Mailer } from '../../platform/mailer.js';
import { POLICIES, type Throttle } from '../../platform/rate-limit.js';
import { withTransaction } from '../../platform/transactions.js';
import type { AuditLog } from '../audit/audit.js';
import { passwordProblem, type PasswordHasher } from './passwords.js';
import { generateRecoveryCodes, generateTotpSecret, otpauthUri, base32Encode, verifyTotp } from './totp.js';

/** Who is making the request; ipHash is a keyed hash, never the raw address. */
export interface RequestMeta {
  ipHash: string;
  userAgent: string;
  requestId: string;
}

export interface Authenticated {
  session: SessionDoc;
  user: UserDoc;
}

const PENDING_MFA_LIFETIME_MS = 10 * 60_000;
const RESET_TOKEN_LIFETIME_MS = 30 * 60_000;
/** Step-up MFA stays valid this long after a code is entered. */
export const STEP_UP_WINDOW_MS = 15 * 60_000;
/** Sliding expiry is refreshed at most this often, to avoid a write on every request. */
const TOUCH_INTERVAL_MS = 60_000;
const ISSUER = 'BizMgmt';

const INVALID_LOGIN = () => new AppError('UNAUTHENTICATED', 'Incorrect email or password');
const INVALID_CODE = () => new AppError('BAD_REQUEST', 'That code is not valid. Try again.');

export interface IdentityDeps {
  config: AppConfig;
  connection: Connection;
  models: Models;
  hasher: PasswordHasher;
  keys: Keyring;
  mailer: Mailer;
  audit: AuditLog;
  throttle: Throttle;
  logger: Logger;
  now?: () => Date;
}

export class IdentityService {
  private readonly now: () => Date;

  constructor(private readonly deps: IdentityDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Keyed hash for throttle keys and audit IPs. */
  lookupHash(kind: string, value: string): string {
    return hmac(this.deps.keys.lookup, `${kind}:${value}`);
  }

  // ---------------------------------------------------------------- sessions

  async resolveSession(token: string): Promise<Authenticated | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now();
    const { Session, User } = this.deps.models;
    const session = await Session.findOne({
      tokenHash: sha256(token),
      revokedAt: null,
      idleExpiresAt: trusted({ $gt: now }),
      absoluteExpiresAt: trusted({ $gt: now }),
    }).lean();
    if (!session) return null;
    const user = await User.findById(session.userId).lean();
    if (!user || user.status !== 'active') return null;
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idleExpiresAt = this.idleExpiry(now, session.absoluteExpiresAt, session.mfaState);
      await Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: now, idleExpiresAt } });
      session.lastSeenAt = now;
      session.idleExpiresAt = idleExpiresAt;
    }
    return { session, user };
  }

  private idleExpiry(now: Date, absolute: Date, mfaState: SessionDoc['mfaState']): Date {
    const idle = mfaState === 'pending' ? PENDING_MFA_LIFETIME_MS : this.deps.config.sessionIdleMs;
    return new Date(Math.min(now.getTime() + idle, absolute.getTime()));
  }

  private async createSession(
    userId: Types.ObjectId,
    meta: RequestMeta,
    options: { mfaState: SessionDoc['mfaState']; mfaVerifiedAt?: Date | null; absoluteExpiresAt?: Date },
    dbSession?: ClientSession,
  ): Promise<{ token: string; session: SessionDoc }> {
    const now = this.now();
    const token = randomToken();
    const absoluteExpiresAt =
      options.absoluteExpiresAt ??
      new Date(now.getTime() + (options.mfaState === 'pending' ? PENDING_MFA_LIFETIME_MS : this.deps.config.sessionAbsoluteMs));
    const doc: SessionDoc = {
      _id: new Types.ObjectId(),
      tokenHash: sha256(token),
      userId,
      mfaState: options.mfaState,
      mfaVerifiedAt: options.mfaVerifiedAt ?? null,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: this.idleExpiry(now, absoluteExpiresAt, options.mfaState),
      absoluteExpiresAt,
      ipHash: meta.ipHash,
      userAgent: meta.userAgent.slice(0, 200),
      revokedAt: null,
    };
    await this.deps.models.Session.create([doc], dbSession ? { session: dbSession } : {});
    return { token, session: doc };
  }

  /** Replaces the session with a new token (session fixation defence). The absolute expiry is kept unless given. */
  private async rotate(
    current: SessionDoc,
    meta: RequestMeta,
    changes: { mfaState?: SessionDoc['mfaState']; mfaVerifiedAt?: Date | null; absoluteExpiresAt?: Date },
  ) {
    await this.revokeSession(current._id);
    return this.createSession(current.userId, meta, {
      mfaState: changes.mfaState ?? current.mfaState,
      mfaVerifiedAt: changes.mfaVerifiedAt === undefined ? current.mfaVerifiedAt : changes.mfaVerifiedAt,
      absoluteExpiresAt: changes.absoluteExpiresAt ?? current.absoluteExpiresAt,
    });
  }

  async revokeSession(sessionId: Types.ObjectId): Promise<void> {
    await this.deps.models.Session.updateOne({ _id: sessionId, revokedAt: null }, { $set: { revokedAt: this.now() } });
  }

  /** Revokes every session of a user, optionally keeping one. Returns how many were revoked. */
  async revokeAllSessions(userId: Types.ObjectId, keep?: Types.ObjectId): Promise<number> {
    const filter: Record<string, unknown> = { userId, revokedAt: null };
    if (keep) filter._id = trusted({ $ne: keep });
    const result = await this.deps.models.Session.updateMany(filter, { $set: { revokedAt: this.now() } });
    return result.modifiedCount;
  }

  async listSessions(auth: Authenticated): Promise<OwnSession[]> {
    const now = this.now();
    const sessions = await this.deps.models.Session.find({
      userId: auth.user._id,
      revokedAt: null,
      mfaState: 'complete',
      idleExpiresAt: trusted({ $gt: now }),
      absoluteExpiresAt: trusted({ $gt: now }),
    })
      .sort({ lastSeenAt: -1 })
      .limit(50)
      .lean();
    return sessions.map((s) => ({
      id: s._id.toHexString(),
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      userAgent: s.userAgent,
      current: s._id.equals(auth.session._id),
    }));
  }

  async revokeOwnSession(auth: Authenticated, sessionId: string, meta: RequestMeta): Promise<void> {
    const result = await this.deps.models.Session.updateOne(
      { _id: new Types.ObjectId(sessionId), userId: auth.user._id, revokedAt: null },
      { $set: { revokedAt: this.now() } },
    );
    if (result.modifiedCount === 0) throw new AppError('NOT_FOUND', 'Session not found');
    await this.audit(auth.user._id, 'auth.session_revoked', 'Signed out a session', meta);
  }

  // ----------------------------------------------------------------- sign-in

  /** Creates a user. The caller provides the transaction (sign-up also creates the tenant). */
  async createUser(
    input: { name: string; email: string; password: string; emailVerified: boolean; lastTenantId?: Types.ObjectId },
    dbSession: ClientSession,
  ): Promise<UserDoc> {
    const problem = passwordProblem(input.password, input);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, [{ path: 'password', message: problem }]);
    const now = this.now();
    const user: Omit<UserDoc, 'createdAt' | 'updatedAt'> = {
      _id: new Types.ObjectId(),
      email: input.email,
      name: input.name,
      passwordHash: await this.deps.hasher.hash(input.password),
      status: 'active',
      mfaEnabled: false,
      emailVerifiedAt: input.emailVerified ? now : null,
      lastLoginAt: now,
      lastTenantId: input.lastTenantId ?? null,
      preferences: { theme: 'system' },
      passwordChangedAt: now,
    };
    try {
      const [created] = await this.deps.models.User.create([user], { session: dbSession });
      if (!created) throw new Error('User was not created');
      return created.toObject();
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new AppError('DUPLICATE', 'An account with this email already exists. Sign in instead.');
      }
      throw err;
    }
  }

  /** Starts a fully authenticated session for a user who just proved their identity (sign-up, invitation). */
  startSession(userId: Types.ObjectId, meta: RequestMeta) {
    return this.createSession(userId, meta, { mfaState: 'complete', mfaVerifiedAt: null });
  }

  async login(email: string, password: string, meta: RequestMeta, current?: SessionDoc) {
    const { throttle, hasher, models } = this.deps;
    const ipKey = `login-ip:${meta.ipHash}`;
    const accountKey = `login-acct:${this.lookupHash('email', email)}`;

    const ipBlock = await throttle.blockedFor(ipKey);
    if (ipBlock > 0) throw rateLimited(ipBlock);

    // A blocked account answers exactly like a wrong password (AC-AUTH-1), after the same amount of work.
    if ((await throttle.blockedFor(accountKey)) > 0) {
      await hasher.verifyDummy(password);
      throw INVALID_LOGIN();
    }

    const user = await models.User.findOne({ email }).lean();
    const ok = user ? await hasher.verify(user.passwordHash, password) : (await hasher.verifyDummy(password), false);
    if (!user || !ok || user.status !== 'active') {
      await Promise.all([throttle.hit(accountKey, POLICIES.loginAccount), throttle.hit(ipKey, POLICIES.loginIp)]);
      if (user) await this.audit(user._id, 'auth.login_failed', 'Failed sign-in attempt', meta);
      throw INVALID_LOGIN();
    }

    await throttle.reset(accountKey);
    const update: Record<string, unknown> = { lastLoginAt: this.now() };
    if (hasher.needsRehash(user.passwordHash)) update.passwordHash = await hasher.hash(password);
    await models.User.updateOne({ _id: user._id }, { $set: update });

    if (current) await this.revokeSession(current._id);
    const created = await this.createSession(user._id, meta, { mfaState: user.mfaEnabled ? 'pending' : 'complete' });
    await this.audit(user._id, 'auth.login', user.mfaEnabled ? 'Signed in with password; MFA code requested' : 'Signed in', meta);
    return created;
  }

  async logout(auth: Authenticated, meta: RequestMeta): Promise<void> {
    await this.revokeSession(auth.session._id);
    await this.audit(auth.user._id, 'auth.logout', 'Signed out', meta);
  }

  async logoutAll(auth: Authenticated, meta: RequestMeta): Promise<void> {
    const count = await this.revokeAllSessions(auth.user._id);
    await this.audit(auth.user._id, 'auth.logout_all', `Signed out of all sessions (${count})`, meta);
  }

  // --------------------------------------------------------------------- MFA

  /** Checks a TOTP or recovery code for the user, consuming it so it cannot be replayed. */
  private async consumeMfaCode(user: UserDoc, code: string, meta: RequestMeta): Promise<void> {
    const key = `mfa:${user._id.toHexString()}`;
    const blocked = await this.deps.throttle.blockedFor(key);
    if (blocked > 0) throw rateLimited(blocked);
    const { MfaFactor } = this.deps.models;
    const factor = await MfaFactor.findOne({ userId: user._id, type: 'totp', status: 'active' }).lean();
    let ok = false;
    if (factor) {
      if (/^\d{6}$/.test(code)) {
        const secret = this.decryptSecret(factor.secretEnc, user._id);
        const step = verifyTotp(secret, code, this.now(), factor.lastUsedStep);
        if (step !== null) {
          const res = await MfaFactor.updateOne({ _id: factor._id, lastUsedStep: trusted({ $lt: step }) }, { $set: { lastUsedStep: step } });
          ok = res.modifiedCount === 1;
        }
      } else {
        const hash = sha256(code.toLowerCase());
        const res = await MfaFactor.updateOne({ _id: factor._id, recoveryCodeHashes: hash }, { $pull: { recoveryCodeHashes: hash } });
        ok = res.modifiedCount === 1;
      }
    }
    if (!ok) {
      await this.deps.throttle.hit(key, POLICIES.mfa);
      await this.audit(user._id, 'auth.mfa_failed', 'Incorrect MFA code', meta);
      throw INVALID_CODE();
    }
    await this.deps.throttle.reset(key);
  }

  /** Completes a sign-in that is waiting for an MFA code. */
  async verifyPendingMfa(auth: Authenticated, code: string, meta: RequestMeta) {
    if (auth.session.mfaState !== 'pending') throw new AppError('INVALID_STATE', 'No MFA code is needed for this session');
    await this.consumeMfaCode(auth.user, code, meta);
    const now = this.now();
    const created = await this.rotate(auth.session, meta, {
      mfaState: 'complete',
      mfaVerifiedAt: now,
      absoluteExpiresAt: new Date(now.getTime() + this.deps.config.sessionAbsoluteMs),
    });
    await this.audit(auth.user._id, 'auth.mfa_verified', 'Completed sign-in with MFA', meta);
    return created;
  }

  /** Re-verifies MFA for sensitive actions (step-up); rotates the session token. */
  async stepUp(auth: Authenticated, code: string, meta: RequestMeta) {
    if (!auth.user.mfaEnabled) throw new AppError('INVALID_STATE', 'Turn on two-step verification first');
    await this.consumeMfaCode(auth.user, code, meta);
    const created = await this.rotate(auth.session, meta, { mfaVerifiedAt: this.now() });
    await this.audit(auth.user._id, 'auth.mfa_verified', 'Confirmed identity for a sensitive action', meta);
    return created;
  }

  private decryptSecret(secretEnc: string, userId: Types.ObjectId): Buffer {
    return decrypt(this.deps.keys.data, secretEnc, `totp:${userId.toHexString()}`);
  }

  async startTotpSetup(auth: Authenticated) {
    if (auth.user.mfaEnabled) throw new AppError('INVALID_STATE', 'Two-step verification is already on');
    const secret = generateTotpSecret();
    const secretEnc = encrypt(this.deps.keys.data, secret, `totp:${auth.user._id.toHexString()}`);
    await this.deps.models.MfaFactor.findOneAndUpdate(
      { userId: auth.user._id, type: 'totp' },
      { $set: { status: 'pending', secretEnc, lastUsedStep: -1, recoveryCodeHashes: [], createdAt: this.now(), confirmedAt: null } },
      { upsert: true },
    );
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(secret, auth.user.email, ISSUER) };
  }

  async confirmTotpSetup(auth: Authenticated, code: string, meta: RequestMeta) {
    const { MfaFactor, User } = this.deps.models;
    const factor = await MfaFactor.findOne({ userId: auth.user._id, type: 'totp', status: 'pending' }).lean();
    if (!factor) throw new AppError('INVALID_STATE', 'Start two-step verification setup first');
    const step = verifyTotp(this.decryptSecret(factor.secretEnc, auth.user._id), code, this.now());
    if (step === null) throw INVALID_CODE();
    const recoveryCodes = generateRecoveryCodes();
    const now = this.now();
    await withTransaction(this.deps.connection, async (s) => {
      const res = await MfaFactor.updateOne(
        { _id: factor._id, status: 'pending' },
        { $set: { status: 'active', confirmedAt: now, lastUsedStep: step, recoveryCodeHashes: recoveryCodes.map((c) => sha256(c)) } },
        { session: s },
      );
      if (res.modifiedCount !== 1) throw new AppError('INVALID_STATE', 'Setup was changed; start again');
      await User.updateOne({ _id: auth.user._id }, { $set: { mfaEnabled: true } }, { session: s });
      await this.audit(auth.user._id, 'auth.mfa_enabled', 'Turned on two-step verification', meta, s);
    });
    // Other sessions were established without MFA; end them.
    await this.revokeAllSessions(auth.user._id, auth.session._id);
    const created = await this.rotate(auth.session, meta, { mfaVerifiedAt: now });
    return { ...created, recoveryCodes };
  }

  async disableMfa(auth: Authenticated, code: string, meta: RequestMeta) {
    if (!auth.user.mfaEnabled) throw new AppError('INVALID_STATE', 'Two-step verification is not on');
    await this.consumeMfaCode(auth.user, code, meta);
    await withTransaction(this.deps.connection, async (s) => {
      await this.deps.models.MfaFactor.deleteOne({ userId: auth.user._id, type: 'totp' }, { session: s });
      await this.deps.models.User.updateOne({ _id: auth.user._id }, { $set: { mfaEnabled: false } }, { session: s });
      await this.audit(auth.user._id, 'auth.mfa_disabled', 'Turned off two-step verification', meta, s);
    });
    return this.rotate(auth.session, meta, { mfaVerifiedAt: null });
  }

  // ---------------------------------------------------------------- passwords

  async changePassword(auth: Authenticated, currentPassword: string, newPassword: string, meta: RequestMeta) {
    const { hasher, throttle } = this.deps;
    const key = `login-acct:${this.lookupHash('email', auth.user.email)}`;
    if ((await throttle.blockedFor(key)) > 0 || !(await hasher.verify(auth.user.passwordHash, currentPassword))) {
      await throttle.hit(key, POLICIES.loginAccount);
      throw new AppError('VALIDATION_FAILED', 'Current password is incorrect', [{ path: 'currentPassword', message: 'Incorrect password' }]);
    }
    await this.setPassword(auth.user, newPassword);
    await this.revokeAllSessions(auth.user._id, auth.session._id);
    const created = await this.rotate(auth.session, meta, {});
    await this.audit(auth.user._id, 'auth.password_changed', 'Changed password; other sessions signed out', meta);
    return created;
  }

  private async setPassword(user: UserDoc, password: string, extra: Record<string, unknown> = {}) {
    const problem = passwordProblem(password, user);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, [{ path: 'newPassword', message: problem }]);
    const passwordHash = await this.deps.hasher.hash(password);
    await this.deps.models.User.updateOne({ _id: user._id }, { $set: { passwordHash, passwordChangedAt: this.now(), ...extra } });
  }

  /**
   * Always succeeds from the caller's point of view, so it does not reveal which
   * emails have accounts. The email is sent after the response (no timing signal).
   */
  async requestPasswordReset(email: string, meta: RequestMeta): Promise<void> {
    const { mailer, throttle, models } = this.deps;
    if (!mailer.enabled) throw new AppError('BUSINESS_RULE', 'Password reset by email is not available on this installation. Ask your administrator.');
    const ipKey = `reset-ip:${meta.ipHash}`;
    const ipBlock = await throttle.blockedFor(ipKey);
    if (ipBlock > 0) throw rateLimited(ipBlock);
    await throttle.hit(ipKey, POLICIES.resetIp);
    const emailKey = `reset-email:${this.lookupHash('email', email)}`;
    if ((await throttle.blockedFor(emailKey)) > 0) return;
    await throttle.hit(emailKey, POLICIES.resetEmail);

    const user = await models.User.findOne({ email, status: 'active' }).lean();
    if (!user) return;
    const token = randomToken();
    const now = this.now();
    await models.PasswordReset.updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: now } });
    await models.PasswordReset.create({ userId: user._id, tokenHash: sha256(token), expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS), usedAt: null, createdAt: now });
    await this.audit(user._id, 'auth.password_reset_requested', 'Requested a password reset link', meta);
    this.sendLater({
      to: user.email,
      subject: 'Reset your BizMgmt password',
      text: [
        `Hello ${user.name},`,
        '',
        'Use this link within 30 minutes to choose a new password:',
        `${this.deps.config.publicAppUrl}/reset-password#token=${token}`,
        '',
        'If you did not ask for this, ignore this email; your password stays the same.',
      ].join('\n'),
    });
  }

  async resetPassword(token: string, newPassword: string, meta: RequestMeta): Promise<void> {
    const { models } = this.deps;
    const now = this.now();
    const live = { tokenHash: sha256(token), usedAt: null, expiresAt: trusted({ $gt: now }) };
    const reset = await models.PasswordReset.findOne(live).lean();
    const user = reset ? await models.User.findOne({ _id: reset.userId, status: 'active' }).lean() : null;
    if (!reset || !user) throw new AppError('NOT_FOUND', 'This reset link is invalid or has expired. Request a new one.');
    const problem = passwordProblem(newPassword, user);
    if (problem) throw new AppError('VALIDATION_FAILED', problem, [{ path: 'newPassword', message: problem }]);
    const consumed = await models.PasswordReset.updateOne(live, { $set: { usedAt: now } });
    if (consumed.modifiedCount !== 1) throw new AppError('NOT_FOUND', 'This reset link is invalid or has expired. Request a new one.');
    await this.setPassword(user, newPassword, user.emailVerifiedAt ? {} : { emailVerifiedAt: now });
    await this.revokeAllSessions(user._id);
    await this.deps.throttle.reset(`login-acct:${this.lookupHash('email', user.email)}`);
    await this.audit(user._id, 'auth.password_reset', 'Reset password by email link; all sessions signed out', meta);
  }

  // ---------------------------------------------------------------- profile

  async setPreferences(auth: Authenticated, preferences: { theme?: ThemePreference | undefined }): Promise<void> {
    if (preferences.theme) await this.deps.models.User.updateOne({ _id: auth.user._id }, { $set: { 'preferences.theme': preferences.theme } });
  }

  async setLastTenant(userId: Types.ObjectId, tenantId: Types.ObjectId): Promise<void> {
    await this.deps.models.User.updateOne({ _id: userId }, { $set: { lastTenantId: tenantId } });
  }

  toSessionUser(user: UserDoc): SessionUser {
    return { id: user._id.toHexString(), name: user.name, email: user.email, mfaEnabled: user.mfaEnabled, preferences: { theme: user.preferences?.theme ?? 'system' } };
  }

  // ---------------------------------------------------------------- helpers

  private async audit(userId: Types.ObjectId, action: Parameters<AuditLog['record']>[0]['action'], summary: string, meta: RequestMeta, s?: ClientSession) {
    await this.deps.audit.record(
      { tenantId: null, actorId: userId, subjectUserId: userId, action, entityType: 'user', entityId: userId.toHexString(), summary, requestId: meta.requestId, ipHash: meta.ipHash },
      s,
    );
  }

  /** Sends after the current request without delaying it. Failures are logged without the message body. */
  sendLater(message: { to: string; subject: string; text: string }): void {
    setImmediate(() => {
      this.deps.mailer.send(message).catch((err: unknown) => this.deps.logger.error({ err: err instanceof Error ? err.message : 'unknown', subject: message.subject }, 'email delivery failed'));
    });
  }
}

export function rateLimited(retryAfterMs: number): AppError {
  const error = new AppError('RATE_LIMITED', 'Too many attempts. Try again later.');
  error.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return error;
}
