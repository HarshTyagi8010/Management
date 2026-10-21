import { trusted } from 'mongoose';
import type { Logger } from 'pino';
import type { Models, OutboxDoc } from '../models.js';
import { CROSS_TENANT } from '../platform/tenant-scope.js';

export interface WorkerTask {
  name: string;
  /** Returns true if it did work (the loop then polls again at once). */
  runOnce(signal: AbortSignal): Promise<boolean>;
}

export type OutboxHandler = (event: OutboxDoc) => Promise<void>;

export const OUTBOX_LEASE_MS = 60_000;
export const OUTBOX_MAX_ATTEMPTS = 8;

/** Exponential backoff: 5 s, 10 s, 20 s … capped at one hour. */
export const backoffMs = (attempts: number) => Math.min(3_600_000, 5_000 * 2 ** Math.max(0, attempts - 1));

/**
 * Outbox consumer (architecture §9). Claims one event at a time with a lease;
 * an event whose lease expired (worker crashed) is claimed again. Handlers must
 * be idempotent: an event can run more than once. After the last attempt the
 * event is marked dead and logged at error level for alerting.
 */
export function outboxConsumer(deps: { models: Models; logger: Logger; handlers: Record<string, OutboxHandler>; now?: () => Date }): WorkerTask {
  const now = () => deps.now?.() ?? new Date();
  return {
    name: 'outbox',
    async runOnce() {
      const at = now();
      const event = await deps.models.Outbox.findOneAndUpdate(
        { $or: [{ status: 'pending', availableAt: trusted({ $lte: at }) }, { status: 'processing', leaseUntil: trusted({ $lt: at }) }] },
        { $set: { status: 'processing', leaseUntil: new Date(at.getTime() + OUTBOX_LEASE_MS) }, $inc: { attempts: 1 } },
        { sort: { availableAt: 1 }, returnDocument: 'after' },
      )
        .setOptions({ [CROSS_TENANT]: 'the worker processes events of every business' })
        .lean();
      if (!event) return false;
      const handler = deps.handlers[event.type];
      try {
        if (!handler) throw new Error(`No handler for outbox event type ${event.type}`);
        await handler(event);
        await deps.models.Outbox.updateOne({ tenantId: event.tenantId, _id: event._id }, { $set: { status: 'done', doneAt: now(), leaseUntil: null, lastError: null } });
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        const dead = event.attempts >= OUTBOX_MAX_ATTEMPTS;
        await deps.models.Outbox.updateOne(
          { tenantId: event.tenantId, _id: event._id },
          { $set: { status: dead ? 'dead' : 'pending', leaseUntil: null, lastError: message, availableAt: new Date(now().getTime() + backoffMs(event.attempts)) } },
        );
        deps.logger[dead ? 'error' : 'warn']({ outboxId: event._id.toHexString(), type: event.type, attempts: event.attempts, err: message }, dead ? 'outbox event is dead' : 'outbox event failed; will retry');
      }
      return true;
    },
  };
}
