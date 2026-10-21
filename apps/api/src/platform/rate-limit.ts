import type { Models } from '../models.js';

export interface ThrottlePolicy {
  /** Events allowed in the window before blocking starts. */
  limit: number;
  windowMs: number;
  /** First block length; doubles with each further event in the window, up to maxBlockMs. */
  blockMs: number;
  maxBlockMs: number;
}

const MINUTE = 60_000;

/** Throttle policies (security.md T1/T13, AC-AUTH-1). */
export const POLICIES = {
  /** Failed sign-ins per account: 5 in 15 min, then 1 min, 2 min, 4 min … up to 15 min. */
  loginAccount: { limit: 5, windowMs: 15 * MINUTE, blockMs: MINUTE, maxBlockMs: 15 * MINUTE },
  /** Failed sign-ins per IP address. */
  loginIp: { limit: 30, windowMs: 15 * MINUTE, blockMs: 5 * MINUTE, maxBlockMs: 60 * MINUTE },
  /** Wrong MFA codes per user. */
  mfa: { limit: 5, windowMs: 15 * MINUTE, blockMs: MINUTE, maxBlockMs: 15 * MINUTE },
  signupIp: { limit: 10, windowMs: 60 * MINUTE, blockMs: 60 * MINUTE, maxBlockMs: 60 * MINUTE },
  resetEmail: { limit: 3, windowMs: 60 * MINUTE, blockMs: 60 * MINUTE, maxBlockMs: 60 * MINUTE },
  resetIp: { limit: 20, windowMs: 60 * MINUTE, blockMs: 60 * MINUTE, maxBlockMs: 60 * MINUTE },
  invitationIp: { limit: 30, windowMs: 15 * MINUTE, blockMs: 15 * MINUTE, maxBlockMs: 60 * MINUTE },
} satisfies Record<string, ThrottlePolicy>;

/**
 * Counters stored in MongoDB so limits hold across API instances. Keys are
 * keyed hashes (never raw emails or IPs). Each update is a single atomic
 * pipeline, so concurrent requests cannot both slip under the limit.
 */
export class Throttle {
  constructor(
    private readonly models: Models,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Milliseconds until the key is unblocked (0 when not blocked). */
  async blockedFor(key: string): Promise<number> {
    const doc = await this.models.RateLimit.collection.findOne({ key }, { projection: { blockedUntil: 1 } });
    const until = doc?.blockedUntil instanceof Date ? doc.blockedUntil.getTime() : 0;
    return Math.max(0, until - this.now().getTime());
  }

  /** Records one event and returns how long the key is now blocked for (0 when under the limit). */
  async hit(key: string, policy: ThrottlePolicy): Promise<number> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - policy.windowMs);
    const result = await this.models.RateLimit.collection.findOneAndUpdate(
      { key },
      [
        { $set: { fresh: { $or: [{ $eq: [{ $type: '$windowStart' }, 'missing'] }, { $lt: ['$windowStart', cutoff] }] } } },
        {
          $set: {
            count: { $cond: ['$fresh', 1, { $add: ['$count', 1] }] },
            windowStart: { $cond: ['$fresh', now, '$windowStart'] },
          },
        },
        {
          $set: {
            blockedUntil: {
              $cond: [
                { $gte: ['$count', policy.limit] },
                { $add: [now, { $min: [policy.maxBlockMs, { $multiply: [policy.blockMs, { $pow: [2, { $subtract: ['$count', policy.limit] }] }] }] }] },
                { $ifNull: ['$blockedUntil', null] },
              ],
            },
            expiresAt: new Date(now.getTime() + Math.max(policy.windowMs, policy.maxBlockMs) + 60 * MINUTE),
          },
        },
        { $unset: 'fresh' },
      ],
      { upsert: true, returnDocument: 'after' },
    );
    const until = result?.blockedUntil instanceof Date ? result.blockedUntil.getTime() : 0;
    return Math.max(0, until - now.getTime());
  }

  async reset(key: string): Promise<void> {
    await this.models.RateLimit.collection.deleteOne({ key });
  }
}
