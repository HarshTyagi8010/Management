import type { ClientSession, Types } from 'mongoose';
import type { Models } from '../models.js';

/** Outbox event types and their payloads (minimal ids; handlers re-read current data). */
export interface OutboxEvents {
  'document.render': { docType: 'stock_transfer' | 'quotation' | 'dispatch' | 'sales_invoice' | 'purchase_order'; docId: string; templateVersion: string };
}
export type OutboxType = keyof OutboxEvents;

/**
 * Writes an outbox row in the caller's transaction (ADR-005): the event exists
 * if and only if the business change committed. The worker processes it later.
 */
export async function enqueue<T extends OutboxType>(models: Models, session: ClientSession, event: { tenantId: Types.ObjectId; type: T; aggregateId: Types.ObjectId; payload: OutboxEvents[T]; now: Date }) {
  await models.Outbox.create(
    [{ tenantId: event.tenantId, type: event.type, aggregateId: event.aggregateId, payload: event.payload, status: 'pending', attempts: 0, availableAt: event.now, leaseUntil: null, lastError: null, createdAt: event.now, doneAt: null }],
    { session },
  );
}
