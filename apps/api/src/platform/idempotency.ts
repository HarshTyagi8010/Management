import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestHandler } from 'express';
import type { ClientSession, Connection, Types } from 'mongoose';
import { idempotencyKeySchema as headerSchema } from '@bizmgmt/contracts';
import { AppError } from '../errors.js';
import type { Models } from '../models.js';
import { sha256 } from './crypto.js';
import { isDuplicateKey } from './values.js';

/**
 * Idempotency keys for commands with financial or stock effects (architecture §7, AC-IDEM-1).
 *
 * The middleware checks the key; the command then runs with the claim in
 * AsyncLocalStorage, and `withTransaction` inserts the record inside the
 * command's own transaction. So the record exists exactly when the command's
 * effects were committed: a failed command leaves nothing behind and can be
 * retried with the same key, and two concurrent uses of one key collide on the
 * unique index (one gets 409). After commit the response is stored for replay.
 */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

interface Claim {
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  route: string;
  requestHash: string;
  createdAt: Date;
  committed: boolean;
}

const claims = new AsyncLocalStorage<Claim>();

/** Called by withTransaction at the start of each attempt: records the claim in this transaction. */
export async function recordClaim(connection: Connection, session: ClientSession): Promise<Claim | null> {
  const claim = claims.getStore();
  if (!claim || claim.committed) return null;
  try {
    await connection.model('IdempotencyKey').create(
      [{ tenantId: claim.tenantId, userId: claim.userId, key: claim.key, route: claim.route, requestHash: claim.requestHash, status: 'committed', responseStatus: null, responseBody: null, createdAt: claim.createdAt, expiresAt: new Date(claim.createdAt.getTime() + IDEMPOTENCY_TTL_MS) }],
      { session },
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new AppError('IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed. Wait a moment, then reload.');
    throw err;
  }
  return claim;
}

/** Stable JSON: object keys sorted at every level, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Route middleware (after authentication, tenant and permission checks).
 * Same key + same request → the stored response is replayed. Same key with a
 * different request (or another user) → 422 IDEMPOTENCY_KEY_REUSED.
 */
export function idempotent(models: Models, now: () => Date = () => new Date()): RequestHandler {
  return async (req, res, next) => {
    if (!req.tenant || !req.auth) return next(new AppError('UNAUTHENTICATED', 'Sign in to continue'));
    const parsed = headerSchema.safeParse(req.headers['idempotency-key']);
    if (!parsed.success) return next(new AppError('BAD_REQUEST', 'An Idempotency-Key header (16–64 letters, digits or hyphens) is required for this command'));
    const key = parsed.data;
    const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
    const requestHash = sha256(`${route}\n${canonicalJson(req.body ?? null)}`);
    const tenantId = req.tenant.tenantId;
    const userId = req.auth.user._id;

    const existing = await models.IdempotencyKey.findOne({ tenantId, key }).lean();
    if (existing) {
      if (!existing.userId.equals(userId) || existing.requestHash !== requestHash) {
        return next(new AppError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request'));
      }
      if (existing.status === 'completed' && existing.responseStatus !== null) {
        res.setHeader('Idempotent-Replayed', 'true');
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }
      return next(new AppError('IDEMPOTENCY_IN_PROGRESS', 'This request was already processed. Reload to see the result.'));
    }

    const claim: Claim = { tenantId, userId, key, route, requestHash, createdAt: now(), committed: false };
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      // Only a committed command with a successful response is stored for replay.
      if (!claim.committed || res.statusCode >= 300) return json(body);
      void models.IdempotencyKey.updateOne({ tenantId, key }, { $set: { status: 'completed', responseStatus: res.statusCode, responseBody: body } })
        .catch(() => undefined)
        .finally(() => json(body));
      return res;
    };
    claims.run(claim, () => next());
  };
}

/** Marks the current claim as committed (called by withTransaction after a successful commit). */
export function markCommitted(claim: Claim | null) {
  if (claim) claim.committed = true;
}
