import { trusted, type ClientSession, type Types } from 'mongoose';
import { AppError } from '../../errors.js';
import type { Models } from '../../models.js';

export interface AssertPeriodOpenInput {
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  docDate: string;
  models: Models;
}

/**
 * Shared contention-safe period-lock guard (Batch A, FINDING-P0-01).
 *
 * Guarantees:
 * 1. Scope: Strictly scoped to tenantId and legalEntityId.
 * 2. Effective date: Validates that accounting-effective date `docDate` > `periodLockDate`.
 * 3. Atomic coordination: Executes within the caller's active MongoDB transaction session.
 * 4. Write-conflict detection: Performs a real shared-record write mutation ($inc: { periodLockCoordination: 1 })
 *    on the LegalEntity document.
 * 5. Deterministic ordering:
 *    A. If posting commits before close: Posting commits its journal/movements and updates the coordination counter.
 *       Period close starts subsequently, sees the committed state, and sets periodLockDate.
 *    B. If close commits before posting: Close updates LegalEntity.periodLockDate. The in-flight posting's
 *       mutation triggers a WiredTiger write conflict on LegalEntity. The driver retries the transaction.
 *       On retry with a fresh snapshot, the query condition (periodLockDate < docDate) evaluates to false,
 *       throwing PERIOD_LOCKED and rolling back all partial effects.
 */
export async function assertPeriodOpen(
  session: ClientSession,
  input: AssertPeriodOpenInput,
): Promise<void> {
  const { tenantId, legalEntityId, docDate, models } = input;

  const updated = await models.LegalEntity.findOneAndUpdate(
    {
      tenantId,
      _id: legalEntityId,
      $or: [
        { periodLockDate: null },
        { periodLockDate: trusted({ $lt: docDate }) },
      ],
    },
    {
      $inc: { periodLockCoordination: 1 },
    },
    {
      session,
      returnDocument: 'after',
    },
  ).lean();

  if (updated) return;

  // The findOneAndUpdate failed to match. Determine whether the entity exists or is locked.
  const existing = await models.LegalEntity.findOne(
    { tenantId, _id: legalEntityId },
    { periodLockDate: 1 },
    { session },
  ).lean();

  if (!existing) {
    throw new AppError('NOT_FOUND', 'Business entity not found');
  }

  throw new AppError(
    'PERIOD_LOCKED',
    `The period up to ${existing.periodLockDate} is locked for this business entity`,
    [{ path: 'docDate', message: 'Locked period' }],
  );
}
