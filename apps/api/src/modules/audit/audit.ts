import { trusted, Types, type ClientSession } from 'mongoose';
import type { AuditAction, AuditChange, AuditEvent } from '@bizmgmt/contracts';
import type { AuditEventDoc, Models } from '../../models.js';

export interface AuditInput {
  tenantId: Types.ObjectId | null;
  actorId: Types.ObjectId | null;
  subjectUserId?: Types.ObjectId | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changes?: AuditChange[];
  requestId: string;
  ipHash: string;
}

/**
 * Append-only audit log (FR-AUD-01). Summaries and changes must not contain
 * secrets; personal data is limited to what identifies the record (e.g. an
 * invited email), never passwords, codes or tokens.
 */
export class AuditLog {
  constructor(private readonly models: Models) {}

  async record(input: AuditInput, session?: ClientSession): Promise<void> {
    const doc: Omit<AuditEventDoc, '_id'> = {
      tenantId: input.tenantId,
      at: new Date(),
      actorId: input.actorId,
      subjectUserId: input.subjectUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary,
      changes: input.changes ?? [],
      requestId: input.requestId,
      ipHash: input.ipHash,
    };
    await this.models.AuditEvent.create([doc], session ? { session } : {});
  }

  async list(tenantId: Types.ObjectId, query: { limit: number; cursor?: string | undefined; action?: AuditAction | undefined }) {
    const filter: Record<string, unknown> = { tenantId };
    if (query.cursor) filter._id = trusted({ $lt: new Types.ObjectId(query.cursor) });
    if (query.action) filter.action = query.action;
    const docs = await this.models.AuditEvent.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .lean();
    const page = docs.slice(0, query.limit);
    const actorIds = [...new Set(page.flatMap((d) => (d.actorId ? [d.actorId.toHexString()] : [])))].map((id) => new Types.ObjectId(id));
    const actors = await this.models.User.find({ _id: trusted({ $in: actorIds }) }, { name: 1 }).lean();
    const names = new Map(actors.map((a) => [a._id.toHexString(), a.name]));
    const data: AuditEvent[] = page.map((d) => ({
      id: d._id.toHexString(),
      at: d.at.toISOString(),
      action: d.action,
      actor: d.actorId ? { id: d.actorId.toHexString(), name: names.get(d.actorId.toHexString()) ?? 'Deleted user' } : null,
      entityType: d.entityType,
      entityId: d.entityId,
      summary: d.summary,
      changes: d.changes,
      requestId: d.requestId,
    }));
    return { data, page: { nextCursor: docs.length > query.limit ? (page.at(-1)?._id.toHexString() ?? null) : null, limit: query.limit } };
  }
}

