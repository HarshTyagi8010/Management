import { Schema, type Types } from 'mongoose';
import type { AccountType, IntegrityCheck } from '@bizmgmt/contracts';
import { appendOnly, tenantScoped } from './platform/tenant-scope.js';

/**
 * Financial engine collections (docs/database/schema.md §2 "Money and ledger"
 * and "Platform"): idempotency records, chart of accounts, journals, outbox,
 * files, generated documents, job locks and integrity check results.
 */
type Decimal = Types.Decimal128;

const objectId = Schema.Types.ObjectId;
const decimal = Schema.Types.Decimal128;

/**
 * A command that committed under an Idempotency-Key (architecture §7). Written
 * inside the command's own transaction, so it exists exactly when the command's
 * effects do; the response is stored right after commit for replays.
 */
export interface IdempotencyKeyDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  route: string;
  requestHash: string;
  /** committed: effects saved, response not yet stored; completed: response stored. */
  status: 'committed' | 'completed';
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export const idempotencyKeySchema = new Schema<IdempotencyKeyDoc>({
  tenantId: { type: objectId, required: true },
  userId: { type: objectId, required: true },
  key: { type: String, required: true },
  route: { type: String, required: true },
  requestHash: { type: String, required: true },
  status: { type: String, enum: ['committed', 'completed'], required: true },
  responseStatus: { type: Number, default: null },
  responseBody: { type: Schema.Types.Mixed, default: null },
  createdAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
});
idempotencyKeySchema.index({ tenantId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
idempotencyKeySchema.plugin(tenantScoped);

export interface AccountDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  code: string;
  name: string;
  type: AccountType;
  system: boolean;
  createdAt: Date;
}

export const accountSchema = new Schema<AccountDoc>({
  tenantId: { type: objectId, required: true },
  legalEntityId: { type: objectId, required: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  system: { type: Boolean, default: true },
  createdAt: { type: Date, required: true },
});
accountSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
accountSchema.plugin(tenantScoped);

export interface JournalLineDoc {
  accountId: Types.ObjectId;
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
}

/** Append-only double-entry journal (financial-policy §8). One per posting; corrections are reversing journals. */
export interface JournalDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  legalEntityId: Types.ObjectId;
  docDate: string;
  sourceType: string;
  sourceId: Types.ObjectId;
  sourceNumber: string;
  narration: string;
  lines: JournalLineDoc[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  reversalOf: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

export const journalSchema = new Schema<JournalDoc>({
  tenantId: { type: objectId, required: true },
  legalEntityId: { type: objectId, required: true },
  docDate: { type: String, required: true },
  sourceType: { type: String, required: true },
  sourceId: { type: objectId, required: true },
  sourceNumber: { type: String, required: true },
  narration: { type: String, default: '' },
  lines: {
    type: [new Schema<JournalLineDoc>({ accountId: { type: objectId, required: true }, accountCode: { type: String, required: true }, debit: { type: decimal, required: true }, credit: { type: decimal, required: true } }, { _id: false })],
    required: true,
  },
  totalDebit: { type: decimal, required: true },
  totalCredit: { type: decimal, required: true },
  reversalOf: { type: objectId, default: null },
  createdBy: { type: objectId, required: true },
  createdAt: { type: Date, required: true },
});
journalSchema.index({ tenantId: 1, legalEntityId: 1, docDate: 1 });
journalSchema.index({ tenantId: 1, legalEntityId: 1, _id: -1 });
// A source document posts once (and may be reversed once).
journalSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1, reversalOf: 1 }, { unique: true });
journalSchema.plugin(tenantScoped);
journalSchema.plugin(appendOnly);

/** Transactional outbox (ADR-005): written with the business change, processed by the worker. */
export interface OutboxDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  type: string;
  aggregateId: Types.ObjectId;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'done' | 'dead';
  attempts: number;
  availableAt: Date;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  doneAt: Date | null;
}

export const outboxSchema = new Schema<OutboxDoc>({
  tenantId: { type: objectId, required: true },
  type: { type: String, required: true },
  aggregateId: { type: objectId, required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, enum: ['pending', 'processing', 'done', 'dead'], required: true },
  attempts: { type: Number, default: 0 },
  availableAt: { type: Date, required: true },
  leaseUntil: { type: Date, default: null },
  lastError: { type: String, default: null },
  createdAt: { type: Date, required: true },
  doneAt: { type: Date, default: null },
});
outboxSchema.index({ status: 1, availableAt: 1 });
outboxSchema.index({ status: 1, leaseUntil: 1 });
outboxSchema.index({ tenantId: 1, aggregateId: 1 });
outboxSchema.plugin(tenantScoped);

/** Metadata for a stored object; keys are random, never user-supplied names (architecture §10). */
export interface FileDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  storageKey: string;
  mime: string;
  size: number;
  sha256: string;
  purpose: string;
  createdAt: Date;
}

export const fileSchema = new Schema<FileDoc>({
  tenantId: { type: objectId, required: true },
  storageKey: { type: String, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  sha256: { type: String, required: true },
  purpose: { type: String, required: true },
  createdAt: { type: Date, required: true },
});
fileSchema.index({ tenantId: 1, storageKey: 1 }, { unique: true });
fileSchema.plugin(tenantScoped);

/** A rendered document (PDF). The original is never regenerated once ready (AC-DOC-1). */
export interface DocumentArtifactDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  docType: string;
  docId: Types.ObjectId;
  templateVersion: string;
  status: 'pending' | 'ready' | 'failed';
  fileId: Types.ObjectId | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const documentArtifactSchema = new Schema<DocumentArtifactDoc>({
  tenantId: { type: objectId, required: true },
  docType: { type: String, required: true },
  docId: { type: objectId, required: true },
  templateVersion: { type: String, required: true },
  status: { type: String, enum: ['pending', 'ready', 'failed'], required: true },
  fileId: { type: objectId, default: null },
  attempts: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
});
documentArtifactSchema.index({ tenantId: 1, docType: 1, docId: 1, templateVersion: 1 }, { unique: true });
documentArtifactSchema.plugin(tenantScoped);

/** Distributed lock so only one worker instance runs each scheduled job (architecture §9). Not tenant data. */
export interface JobLockDoc {
  _id: string;
  owner: string | null;
  lockedUntil: Date;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastResult: string | null;
}

export const jobLockSchema = new Schema<JobLockDoc>({
  _id: { type: String, required: true },
  owner: { type: String, default: null },
  lockedUntil: { type: Date, required: true },
  lastStartedAt: { type: Date, default: null },
  lastFinishedAt: { type: Date, default: null },
  lastResult: { type: String, default: null },
});

/** Latest result of each scheduled integrity check per business. */
export interface IntegrityCheckDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  kind: IntegrityCheck['kind'];
  checkedAt: Date;
  ok: boolean;
  issueCount: number;
  summary: string;
}

export const integrityCheckSchema = new Schema<IntegrityCheckDoc>({
  tenantId: { type: objectId, required: true },
  kind: { type: String, required: true },
  checkedAt: { type: Date, required: true },
  ok: { type: Boolean, required: true },
  issueCount: { type: Number, required: true },
  summary: { type: String, required: true },
});
integrityCheckSchema.index({ tenantId: 1, kind: 1 }, { unique: true });
integrityCheckSchema.plugin(tenantScoped);
