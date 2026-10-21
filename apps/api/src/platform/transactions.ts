import { setTimeout as sleep } from 'node:timers/promises';
import type { ClientSession, Connection } from 'mongoose';
import { markCommitted, recordClaim } from './idempotency.js';

/** Total time a command may spend retrying transient transaction errors before giving up. */
const RETRY_BUDGET_MS = 60_000;
const TXN_OPTIONS = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' } as const;

const hasLabel = (err: unknown, label: string) => typeof (err as { hasErrorLabel?: unknown })?.hasErrorLabel === 'function' && (err as { hasErrorLabel(l: string): boolean }).hasErrorLabel(label);

/** Exponential backoff with full jitter: concurrent writers of one document spread out instead of colliding again at once. */
const backoff = (attempt: number) => Math.random() * Math.min(1_000, 10 * 2 ** attempt);

/**
 * Runs `fn` in a MongoDB transaction (replica set required) with snapshot reads
 * and majority writes (architecture §6).
 *
 * Transient errors (write conflicts, elections) abort the attempt and retry the
 * whole callback after a jittered backoff, within a time budget, so many
 * transactions contending for one document (e.g. a numbering counter) settle
 * instead of livelocking. `fn` therefore must not perform external side effects
 * (email, HTTP): queue those in the outbox, which commits with the transaction.
 *
 * When the request carries an Idempotency-Key, its record is written in the
 * same transaction (platform/idempotency.ts).
 */
export async function withTransaction<T>(connection: Connection, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await connection.startSession();
  const started = Date.now();
  try {
    for (let attempt = 1; ; attempt += 1) {
      session.startTransaction(TXN_OPTIONS);
      let claim: Awaited<ReturnType<typeof recordClaim>> = null;
      let result: T;
      try {
        claim = await recordClaim(connection, session);
        result = await fn(session);
      } catch (err) {
        await session.abortTransaction().catch(() => undefined);
        if (hasLabel(err, 'TransientTransactionError') && Date.now() - started < RETRY_BUDGET_MS) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
      try {
        await commit(session, started);
      } catch (err) {
        // A conflict found at commit time: the whole transaction is retried.
        if (hasLabel(err, 'TransientTransactionError') && Date.now() - started < RETRY_BUDGET_MS) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }
      markCommitted(claim);
      return result;
    }
  } finally {
    await session.endSession();
  }
}

/** Commits, retrying when the outcome is unknown (e.g. a network blip): committing again is safe. */
async function commit(session: ClientSession, started: number) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await session.commitTransaction();
      return;
    } catch (err) {
      if (hasLabel(err, 'UnknownTransactionCommitResult') && Date.now() - started < RETRY_BUDGET_MS) {
        await sleep(backoff(attempt));
        continue;
      }
      throw err;
    }
  }
}
