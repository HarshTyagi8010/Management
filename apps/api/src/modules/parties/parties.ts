import { trusted, Types } from 'mongoose';
import { phoneKey, type AuditChange, type CrmNote, type CrmTask, type Party, type TimelineEntry } from '@bizmgmt/contracts';
import { AppError } from '../../errors.js';
import type { CrmNoteDoc, CrmTaskDoc, Models, PartyDoc } from '../../models.js';
import { decodeCursor, encodeCursor, escapeRegex, fromDecimal, nameKey, toDecimalOrNull, versionConflict } from '../../platform/values.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { RequestMeta } from '../identity/identity.js';
import type { TenantContext } from '../tenancy/tenancy.js';

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);

type AddressIn = { id: string; label: string; isBilling: boolean; isShipping: boolean; line1: string; line2: string; city: string; district: string; stateCode: string; pincode: string };
type ContactIn = { id: string; name: string; designation: string; phone: string; email: string };

export interface PartyInput {
  name: string;
  legalName: string;
  isCustomer: boolean;
  isSupplier: boolean;
  pan: string;
  gstins: Array<{ gstin: string; addressId: string | null }>;
  addresses: AddressIn[];
  contacts: ContactIn[];
  creditLimit: string | null;
  paymentTermsDays: number | null;
  tags: string[];
}

type Optional<T> = { [K in keyof T]?: T[K] | undefined };

/** Parties (FR-PTY-01/02/05) and CRM notes and follow-ups (FR-PTY-04). Parties are archived, never deleted. */
export class PartiesService {
  constructor(private readonly deps: { models: Models; audit: AuditLog; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>) {
    return this.deps.audit.record({ ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash });
  }

  /** Full detail needs party.view; party.view_basic (storekeepers) sees name and addresses only. */
  private toParty(ctx: TenantContext, p: PartyDoc): Party {
    const basic = {
      id: p._id.toHexString(),
      name: p.name,
      legalName: p.legalName,
      isCustomer: p.isCustomer,
      isSupplier: p.isSupplier,
      addresses: p.addresses.map((a) => ({ id: a.id, label: a.label, isBilling: a.isBilling, isShipping: a.isShipping, line1: a.line1, line2: a.line2, city: a.city, district: a.district, stateCode: a.stateCode, pincode: a.pincode })),
      archived: p.archivedAt !== null,
      version: p.version,
    };
    if (!ctx.permissions.has('party.view')) return basic;
    return {
      ...basic,
      pan: p.pan ?? '',
      gstins: p.gstins.map((g) => ({ gstin: g.gstin, stateCode: g.stateCode, addressId: g.addressId })),
      contacts: p.contacts.map((c) => ({ id: c.id, name: c.name, designation: c.designation, phone: c.phone, email: c.email })),
      creditLimit: fromDecimal(p.creditLimit),
      paymentTermsDays: p.paymentTermsDays,
      tags: p.tags,
    };
  }

  private toDoc(input: PartyInput) {
    return {
      name: input.name,
      nameKey: nameKey(input.name),
      legalName: input.legalName,
      isCustomer: input.isCustomer,
      isSupplier: input.isSupplier,
      pan: input.pan || null,
      gstins: input.gstins.map((g) => ({ gstin: g.gstin, stateCode: g.gstin.slice(0, 2), addressId: g.addressId })),
      addresses: input.addresses,
      contacts: input.contacts.map((c) => ({ ...c, phoneKey: c.phone ? phoneKey(c.phone) : '' })),
      creditLimit: toDecimalOrNull(input.creditLimit),
      paymentTermsDays: input.paymentTermsDays,
      tags: [...new Set(input.tags)],
    };
  }

  /**
   * Duplicate detection (FR-PTY-02): other live parties with the same GSTIN, PAN or
   * phone. Saving needs `confirmDuplicates` once the user has seen the matches.
   */
  private async findDuplicates(ctx: TenantContext, doc: ReturnType<PartiesService['toDoc']>, exceptId?: Types.ObjectId) {
    const gstins = doc.gstins.map((g) => g.gstin);
    const phones = doc.contacts.map((c) => c.phoneKey).filter(Boolean);
    const or: Record<string, unknown>[] = [];
    if (gstins.length) or.push({ 'gstins.gstin': trusted({ $in: gstins }) });
    if (doc.pan) or.push({ pan: doc.pan });
    if (phones.length) or.push({ 'contacts.phoneKey': trusted({ $in: phones }) });
    if (or.length === 0) return [];
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, archivedAt: null, $or: or };
    if (exceptId) filter._id = trusted({ $ne: exceptId });
    const matches = await this.deps.models.Party.find(filter, { name: 1, gstins: 1, pan: 1, contacts: 1 }).limit(10).lean();
    return matches.flatMap((m) => {
      const why: string[] = [];
      if (m.gstins.some((g) => gstins.includes(g.gstin))) why.push('GSTIN');
      if (doc.pan && m.pan === doc.pan) why.push('PAN');
      if (m.contacts.some((c) => c.phoneKey && phones.includes(c.phoneKey))) why.push('phone');
      return why.length ? [{ path: `duplicate.${m._id.toHexString()}`, message: `${m.name} has the same ${why.join(', ')}` }] : [];
    });
  }

  private async guardDuplicates(ctx: TenantContext, doc: ReturnType<PartiesService['toDoc']>, confirm: boolean, exceptId?: Types.ObjectId) {
    const duplicates = await this.findDuplicates(ctx, doc, exceptId);
    if (duplicates.length && !confirm) {
      throw new AppError('DUPLICATE', 'This looks like a party you already have. Check the matches, then save anyway if it is different.', duplicates);
    }
    return duplicates;
  }

  async list(ctx: TenantContext, query: { q?: string | undefined; role?: 'customer' | 'supplier' | undefined; archived: 'true' | 'false'; limit: number; cursor?: string | undefined }) {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, archivedAt: query.archived === 'true' ? trusted({ $ne: null }) : null };
    if (query.role === 'customer') filter.isCustomer = true;
    if (query.role === 'supplier') filter.isSupplier = true;
    const and: Record<string, unknown>[] = [];
    if (query.q) {
      const or: Record<string, unknown>[] = [{ nameKey: trusted({ $regex: escapeRegex(nameKey(query.q)) }) }];
      // Identifier search only for callers who may see identifiers.
      if (ctx.permissions.has('party.view')) {
        const upper = query.q.toUpperCase().replace(/\s/g, '');
        if (/^[0-9A-Z]{2,15}$/.test(upper)) or.push({ 'gstins.gstin': trusted({ $regex: `^${escapeRegex(upper)}` }) });
        const digits = phoneKey(query.q);
        if (digits.length >= 6) or.push({ 'contacts.phoneKey': digits });
      }
      and.push({ $or: or });
    }
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      and.push({ $or: [{ nameKey: trusted({ $gt: c.sortKey }) }, { nameKey: c.sortKey, _id: trusted({ $gt: c.id }) }] });
    }
    if (and.length) filter.$and = and;
    const rows = await this.deps.models.Party.find(filter).sort({ nameKey: 1, _id: 1 }).limit(query.limit + 1).lean();
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return { data: page.map((p) => this.toParty(ctx, p)), page: { nextCursor: rows.length > query.limit && last ? encodeCursor(last.nameKey, last._id) : null, limit: query.limit } };
  }

  private async findParty(ctx: TenantContext, id: string | Types.ObjectId) {
    const party = await this.deps.models.Party.findOne({ tenantId: ctx.tenantId, _id: typeof id === 'string' ? new Types.ObjectId(id) : id }).lean();
    if (!party) throw notFound('Party');
    return party;
  }

  async get(ctx: TenantContext, id: string): Promise<Party> {
    return this.toParty(ctx, await this.findParty(ctx, id));
  }

  async create(ctx: TenantContext, input: PartyInput & { confirmDuplicates: boolean }, meta: RequestMeta): Promise<Party> {
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, ...this.toDoc(input), archivedAt: null, version: 0 };
    const duplicates = await this.guardDuplicates(ctx, doc, input.confirmDuplicates);
    await this.deps.models.Party.create([doc]);
    const roles = [input.isCustomer && 'customer', input.isSupplier && 'supplier'].filter(Boolean).join(' and ');
    await this.record(ctx, meta, { action: 'party.created', entityType: 'party', entityId: doc._id.toHexString(), summary: `Added ${roles} "${input.name}"`, changes: [{ field: 'gstins', to: doc.gstins.map((g) => g.gstin) }] });
    if (duplicates.length) {
      await this.record(ctx, meta, { action: 'party.duplicate_confirmed', entityType: 'party', entityId: doc._id.toHexString(), summary: `Saved despite possible duplicates: ${duplicates.map((d) => d.message).join('; ')}` });
    }
    return this.toParty(ctx, { ...doc, createdAt: this.now(), updatedAt: this.now() });
  }

  async update(ctx: TenantContext, id: string, input: Optional<PartyInput> & { version: number; confirmDuplicates: boolean; archived?: boolean | undefined }, meta: RequestMeta): Promise<Party> {
    const party = await this.findParty(ctx, id);
    const current: PartyInput = {
      name: party.name,
      legalName: party.legalName,
      isCustomer: party.isCustomer,
      isSupplier: party.isSupplier,
      pan: party.pan ?? '',
      gstins: party.gstins.map((g) => ({ gstin: g.gstin, addressId: g.addressId })),
      addresses: party.addresses,
      contacts: party.contacts.map(({ phoneKey: _key, ...c }) => c),
      creditLimit: fromDecimal(party.creditLimit),
      paymentTermsDays: party.paymentTermsDays,
      tags: party.tags,
    };
    const { version, confirmDuplicates, archived, ...fields } = input;
    const next: PartyInput = { ...current, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    if (!next.isCustomer && !next.isSupplier) throw new AppError('VALIDATION_FAILED', 'A party must be a customer, a supplier or both', [{ path: 'isCustomer', message: 'Required' }]);
    next.gstins.forEach((g, i) => {
      if (next.pan && g.gstin.slice(2, 12) !== next.pan) throw new AppError('VALIDATION_FAILED', 'This GSTIN belongs to a different PAN', [{ path: `gstins.${i}.gstin`, message: 'PAN mismatch' }]);
      if (g.addressId && !next.addresses.some((a) => a.id === g.addressId)) throw new AppError('VALIDATION_FAILED', 'Unknown address', [{ path: `gstins.${i}.addressId`, message: 'Unknown address' }]);
    });
    const changed = (Object.keys(next) as Array<keyof PartyInput>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current[k]));
    const doc = this.toDoc(next);
    const identifiersChanged = changed.some((k) => k === 'gstins' || k === 'pan' || k === 'contacts');
    const restoring = archived === false && party.archivedAt !== null;
    const duplicates = identifiersChanged || restoring ? await this.guardDuplicates(ctx, doc, confirmDuplicates, party._id) : [];
    const set: Record<string, unknown> = { ...doc };
    if (archived !== undefined) set.archivedAt = archived ? (party.archivedAt ?? this.now()) : null;
    const updated = await this.deps.models.Party.findOneAndUpdate({ tenantId: ctx.tenantId, _id: party._id, version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('party');
    // Business identifiers and terms with values; personal contact details only as "changed".
    const valued = new Set(['name', 'legalName', 'isCustomer', 'isSupplier', 'pan', 'gstins', 'creditLimit', 'paymentTermsDays', 'tags']);
    const changes: AuditChange[] = changed.map((field) => (valued.has(field) ? { field, from: current[field], to: next[field] } : { field }));
    if (archived !== undefined && archived !== (party.archivedAt !== null)) changes.push({ field: 'archived', from: party.archivedAt !== null, to: archived });
    if (changes.length) await this.record(ctx, meta, { action: 'party.updated', entityType: 'party', entityId: id, summary: `Updated "${updated.name}"`, changes });
    if (duplicates.length) await this.record(ctx, meta, { action: 'party.duplicate_confirmed', entityType: 'party', entityId: id, summary: `Saved despite possible duplicates: ${duplicates.map((d) => d.message).join('; ')}` });
    return this.toParty(ctx, updated);
  }

  // ------------------------------------------------------------------- CRM

  private async userNames(ids: Types.ObjectId[]) {
    const unique = [...new Set(ids.map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id));
    const users = unique.length ? await this.deps.models.User.find({ _id: trusted({ $in: unique }) }, { name: 1 }).lean() : [];
    return new Map(users.map((u) => [u._id.toHexString(), u.name]));
  }

  private async toTasks(ctx: TenantContext, tasks: CrmTaskDoc[]): Promise<CrmTask[]> {
    const names = await this.userNames(tasks.flatMap((t) => [t.assigneeId, t.createdBy]));
    const partyIds = [...new Set(tasks.map((t) => t.partyId.toHexString()))].map((id) => new Types.ObjectId(id));
    const parties = partyIds.length ? await this.deps.models.Party.find({ tenantId: ctx.tenantId, _id: trusted({ $in: partyIds }) }, { name: 1 }).lean() : [];
    const partyName = new Map(parties.map((p) => [p._id.toHexString(), p.name]));
    return tasks.map((t) => ({
      id: t._id.toHexString(),
      partyId: t.partyId.toHexString(),
      partyName: partyName.get(t.partyId.toHexString()) ?? 'Unknown party',
      title: t.title,
      details: t.details,
      dueDate: t.dueDate,
      status: t.status,
      assignee: { id: t.assigneeId.toHexString(), name: names.get(t.assigneeId.toHexString()) ?? 'Former member' },
      createdBy: names.get(t.createdBy.toHexString()) ?? 'Former member',
      createdAt: t.createdAt.toISOString(),
      completedAt: t.completedAt?.toISOString() ?? null,
      version: t.version,
    }));
  }

  private async toNotes(notes: CrmNoteDoc[]): Promise<CrmNote[]> {
    const names = await this.userNames(notes.map((n) => n.authorId));
    return notes.map((n) => ({ id: n._id.toHexString(), partyId: n.partyId.toHexString(), body: n.body, author: names.get(n.authorId.toHexString()) ?? 'Former member', createdAt: n.createdAt.toISOString() }));
  }

  async timeline(ctx: TenantContext, partyId: string): Promise<TimelineEntry[]> {
    const party = await this.findParty(ctx, partyId);
    const [notes, tasks] = await Promise.all([
      this.deps.models.CrmNote.find({ tenantId: ctx.tenantId, partyId: party._id }).sort({ _id: -1 }).limit(200).lean(),
      this.deps.models.CrmTask.find({ tenantId: ctx.tenantId, partyId: party._id }).sort({ dueDate: -1 }).limit(200).lean(),
    ]);
    const entries: TimelineEntry[] = [
      ...(await this.toNotes(notes)).map((note) => ({ kind: 'note' as const, at: note.createdAt, note })),
      ...(await this.toTasks(ctx, tasks)).map((task) => ({ kind: 'task' as const, at: task.createdAt, task })),
    ];
    return entries.sort((a, b) => b.at.localeCompare(a.at));
  }

  async addNote(ctx: TenantContext, partyId: string, body: string): Promise<CrmNote> {
    const party = await this.findParty(ctx, partyId);
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, partyId: party._id, body, authorId: ctx.userId, createdAt: this.now() };
    await this.deps.models.CrmNote.create([doc]);
    const [note] = await this.toNotes([doc]);
    if (!note) throw new Error('note missing');
    return note;
  }

  /** Assignees must be active members of this tenant (an id from another tenant is rejected, not resolved). */
  private async assertMember(ctx: TenantContext, userId: Types.ObjectId) {
    const ok = await this.deps.models.Membership.countDocuments({ tenantId: ctx.tenantId, userId, status: 'active' });
    if (!ok) throw new AppError('VALIDATION_FAILED', 'Choose someone in this business', [{ path: 'assigneeId', message: 'Not a member' }]);
  }

  async createTask(ctx: TenantContext, partyId: string, input: { title: string; details: string; dueDate: string; assigneeId: string | null }, meta: RequestMeta): Promise<CrmTask> {
    const party = await this.findParty(ctx, partyId);
    const assigneeId = input.assigneeId ? new Types.ObjectId(input.assigneeId) : ctx.userId;
    await this.assertMember(ctx, assigneeId);
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, partyId: party._id, title: input.title, details: input.details, dueDate: input.dueDate, assigneeId, status: 'open' as const, createdBy: ctx.userId, completedAt: null, version: 0 };
    await this.deps.models.CrmTask.create([doc]);
    await this.record(ctx, meta, { action: 'crm.task_created', entityType: 'crm_task', entityId: doc._id.toHexString(), summary: `Follow-up "${input.title}" for "${party.name}" due ${input.dueDate}` });
    const [task] = await this.toTasks(ctx, [{ ...doc, createdAt: this.now(), updatedAt: this.now() }]);
    if (!task) throw new Error('task missing');
    return task;
  }

  async updateTask(
    ctx: TenantContext,
    taskId: string,
    input: { version: number; title?: string | undefined; details?: string | undefined; dueDate?: string | undefined; assigneeId?: string | undefined; status?: 'open' | 'done' | 'cancelled' | undefined },
    meta: RequestMeta,
  ): Promise<CrmTask> {
    const task = await this.deps.models.CrmTask.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(taskId) }).lean();
    if (!task) throw notFound('Follow-up');
    const set: Record<string, unknown> = {};
    for (const key of ['title', 'details', 'dueDate', 'status'] as const) if (input[key] !== undefined) set[key] = input[key];
    if (input.assigneeId) {
      const assigneeId = new Types.ObjectId(input.assigneeId);
      await this.assertMember(ctx, assigneeId);
      set.assigneeId = assigneeId;
    }
    if (input.status && input.status !== task.status) set.completedAt = input.status === 'open' ? null : this.now();
    const updated = await this.deps.models.CrmTask.findOneAndUpdate({ tenantId: ctx.tenantId, _id: task._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('follow-up');
    const changes: AuditChange[] = Object.keys(set)
      .filter((k) => k !== 'completedAt')
      .map((field) => (field === 'details' || field === 'assigneeId' ? { field } : { field, from: (task as unknown as Record<string, unknown>)[field], to: set[field] }));
    await this.record(ctx, meta, { action: 'crm.task_updated', entityType: 'crm_task', entityId: taskId, summary: `Updated follow-up "${updated.title}"`, changes });
    const [result] = await this.toTasks(ctx, [updated]);
    if (!result) throw new Error('task missing');
    return result;
  }

  async listTasks(ctx: TenantContext, query: { assignee: 'me' | 'anyone'; status: 'open' | 'done' | 'cancelled'; partyId?: string | undefined; limit: number }): Promise<CrmTask[]> {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, status: query.status };
    if (query.assignee === 'me') filter.assigneeId = ctx.userId;
    if (query.partyId) filter.partyId = new Types.ObjectId(query.partyId);
    const rows = await this.deps.models.CrmTask.find(filter)
      .sort({ dueDate: query.status === 'open' ? 1 : -1, _id: 1 })
      .limit(query.limit)
      .lean();
    return this.toTasks(ctx, rows);
  }
}
