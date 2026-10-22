import { createHash, randomBytes } from 'node:crypto';
import { trusted, Types } from 'mongoose';
import {
  DEFAULT_WORKFLOW,
  DOCUMENT_TYPES,
  LOGO_MAX_BYTES,
  formatDocumentNumber,
  financialYear,
  renderedPrefixLength,
  seriesCapacity,
  stateName,
  type AuditChange,
  type DocumentSeries,
  type DocumentType,
  type GstRegistration,
  type LegalEntity,
  type Permission,
  type TurnoverBand,
  type WorkflowSettings,
} from '@bizmgmt/contracts';
import { AppError } from '../../errors.js';
import type { BankAccountDoc, DocumentSeriesDoc, GstRegistrationDoc, LegalEntityDoc, Models } from '../../models.js';
import { inspectImage } from '../../platform/images.js';
import type { ObjectStorage } from '../../platform/storage.js';
import { isDuplicateKey, todayIST, versionConflict } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';
import type { AuditInput, AuditLog } from '../audit/audit.js';
import type { JournalService } from '../finance/journals.js';
import type { RequestMeta } from '../identity/identity.js';
import { canInAllEntities, canInEntity, visibleEntities, type TenantContext } from '../tenancy/tenancy.js';

const notFound = (what: string) => new AppError('NOT_FOUND', `${what} not found`);
const forbidden = () => new AppError('FORBIDDEN', "You don't have permission to do this");

type EntityInput = {
  legalName: string;
  tradeName: string;
  pan: string;
  constitution: string;
  address: LegalEntityDoc['address'];
  email: string;
  phone: string;
  turnoverBand: TurnoverBand;
};

type Optional<T> = { [K in keyof T]?: T[K] | undefined };

/** Legal entities, GST registrations, workflow settings and document series (FR-CO-01..06). */
export class OrganizationService {
  constructor(private readonly deps: { models: Models; audit: AuditLog; journals: JournalService; storage: ObjectStorage; now?: () => Date }) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private record(ctx: TenantContext, meta: RequestMeta, input: Omit<AuditInput, 'tenantId' | 'actorId' | 'requestId' | 'ipHash'>) {
    return this.deps.audit.record({ ...input, tenantId: ctx.tenantId, actorId: ctx.userId, requestId: meta.requestId, ipHash: meta.ipHash });
  }

  /** Loads an entity the caller can see; anything else (other tenant, out of scope) is "not found". */
  private async findEntity(ctx: TenantContext, id: string | Types.ObjectId): Promise<LegalEntityDoc> {
    const _id = typeof id === 'string' ? new Types.ObjectId(id) : id;
    const scope = visibleEntities(ctx);
    if (scope !== 'all' && !scope.has(_id.toHexString())) throw notFound('Business entity');
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id }).lean();
    if (!entity) throw notFound('Business entity');
    return entity;
  }

  private require(ctx: TenantContext, permission: Permission, entityId: Types.ObjectId) {
    if (!canInEntity(ctx, permission, entityId)) throw forbidden();
  }

  private canReadSettings(ctx: TenantContext, entityId: Types.ObjectId) {
    return canInEntity(ctx, 'settings.view', entityId) || canInEntity(ctx, 'settings.company', entityId);
  }

  private toEntity(ctx: TenantContext, e: LegalEntityDoc, registrationCount: number): LegalEntity {
    return {
      id: e._id.toHexString(),
      legalName: e.legalName,
      tradeName: e.tradeName,
      pan: e.pan,
      constitution: e.constitution as LegalEntity['constitution'],
      address: e.address,
      email: e.email,
      phone: e.phone,
      fyStartMonth: 4,
      turnoverBand: e.turnoverBand,
      workflow: e.workflow,
      periodLockDate: e.periodLockDate,
      ...(this.canReadSettings(ctx, e._id) ? { bankAccounts: e.bankAccounts.map((b) => ({ ...b })) } : {}),
      logo: e.logo ? { contentType: e.logo.contentType, sizeBytes: e.logo.sizeBytes, width: e.logo.width, height: e.logo.height } : null,
      registrationCount,
      archived: e.archivedAt !== null,
      version: e.version,
    };
  }

  // -------------------------------------------------------- legal entities

  async listEntities(ctx: TenantContext): Promise<LegalEntity[]> {
    const scope = visibleEntities(ctx);
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
    if (scope !== 'all') filter._id = trusted({ $in: [...scope].map((id) => new Types.ObjectId(id)) });
    const entities = await this.deps.models.LegalEntity.find(filter).sort({ legalName: 1 }).limit(100).lean();
    const counts = await this.registrationCounts(ctx, entities.map((e) => e._id));
    return entities.map((e) => this.toEntity(ctx, e, counts.get(e._id.toHexString()) ?? 0));
  }

  private async registrationCounts(ctx: TenantContext, ids: Types.ObjectId[]) {
    const rows = await this.deps.models.GstRegistration.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { tenantId: ctx.tenantId, legalEntityId: { $in: ids } } },
      { $group: { _id: '$legalEntityId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id.toHexString(), r.n]));
  }

  async getEntity(ctx: TenantContext, id: string): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    const counts = await this.registrationCounts(ctx, [entity._id]);
    return this.toEntity(ctx, entity, counts.get(entity._id.toHexString()) ?? 0);
  }

  async createEntity(ctx: TenantContext, input: EntityInput, meta: RequestMeta): Promise<LegalEntity> {
    // A new entity is outside any limited scope, so only people with company settings everywhere may create one.
    if (!canInAllEntities(ctx, 'settings.company')) throw forbidden();
    const doc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      ...input,
      fyStartMonth: 4 as const,
      workflow: DEFAULT_WORKFLOW,
      bankAccounts: [],
      periodLockDate: null,
      logo: null,
      archivedAt: null,
      version: 0,
    };
    try {
      await this.deps.models.LegalEntity.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError('DUPLICATE', 'A business entity with this PAN already exists', [{ path: 'pan', message: 'Already used' }]);
      throw err;
    }
    // Every entity keeps its own books (ADR-011).
    await this.deps.journals.ensureAccounts(ctx.tenantId, doc._id);
    await this.record(ctx, meta, { action: 'legal_entity.created', entityType: 'legal_entity', entityId: doc._id.toHexString(), summary: `Added business entity "${input.legalName}"` });
    return this.getEntity(ctx, doc._id.toHexString());
  }

  async updateEntity(ctx: TenantContext, id: string, input: Optional<EntityInput> & { version: number }, meta: RequestMeta): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    this.require(ctx, 'settings.company', entity._id);
    const { version, ...fields } = input;
    const set: Record<string, unknown> = {};
    const changes: AuditChange[] = [];
    for (const [key, value] of Object.entries(fields) as Array<[keyof EntityInput, unknown]>) {
      if (value === undefined || JSON.stringify(value) === JSON.stringify(entity[key])) continue;
      set[key] = value;
      // Values for codes and names; contact details are recorded as "changed" only.
      const showValue = ['legalName', 'tradeName', 'pan', 'constitution', 'turnoverBand'].includes(key);
      changes.push(showValue ? { field: key, from: entity[key], to: value } : { field: key });
    }
    if (set.pan !== undefined && (await this.deps.models.GstRegistration.countDocuments({ tenantId: ctx.tenantId, legalEntityId: entity._id })) > 0) {
      throw new AppError('BUSINESS_RULE', 'The PAN cannot change while GST registrations exist: every GSTIN contains the PAN');
    }
    if (changes.length === 0) return this.getEntity(ctx, id);
    let updated;
    try {
      updated = await this.deps.models.LegalEntity.findOneAndUpdate({ tenantId: ctx.tenantId, _id: entity._id, version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError('DUPLICATE', 'A business entity with this PAN already exists', [{ path: 'pan', message: 'Already used' }]);
      throw err;
    }
    if (!updated) throw versionConflict('business entity');
    await this.record(ctx, meta, { action: 'legal_entity.updated', entityType: 'legal_entity', entityId: id, summary: `Updated "${updated.legalName}"`, changes });
    return this.getEntity(ctx, id);
  }

  /**
   * Workflow settings (FR-CO-04). The stock-out point can change only while no
   * open sales document depends on it: otherwise goods could leave twice, or
   * never (FR-INV-10). The stock-in point gets the same rule with purchasing (Phase 8).
   */
  async updateWorkflow(ctx: TenantContext, id: string, input: WorkflowSettings & { version: number }, meta: RequestMeta): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    this.require(ctx, 'settings.workflow', entity._id);
    const { version, ...workflow } = input;
    if (workflow.stockOutPoint !== entity.workflow.stockOutPoint) {
      const { SalesOrder, Dispatch, SalesInvoice } = this.deps.models;
      const scope = { tenantId: ctx.tenantId, legalEntityId: entity._id };
      const [orders, dispatches, invoices] = await Promise.all([
        SalesOrder.countDocuments({ ...scope, status: trusted({ $in: ['draft', 'confirmed', 'partially_fulfilled'] }) }),
        Dispatch.countDocuments({ ...scope, status: trusted({ $in: ['draft', 'dispatched', 'partially_invoiced'] }) }),
        SalesInvoice.countDocuments({ ...scope, status: 'draft' }),
      ]);
      if (orders + dispatches + invoices > 0) {
        const open = [orders && `${orders} open sales order(s)`, dispatches && `${dispatches} dispatch(es) still drafts or not fully invoiced`, invoices && `${invoices} draft invoice(s)`].filter(Boolean).join(', ');
        throw new AppError('BUSINESS_RULE', `The stock-out point can’t change while sales documents depend on it: ${open}. Finish, close or discard them first.`, [{ path: 'stockOutPoint', message: 'Open documents' }]);
      }
    }
    const changes: AuditChange[] = (Object.keys(workflow) as Array<keyof WorkflowSettings>)
      .filter((k) => workflow[k] !== entity.workflow[k])
      .map((k) => ({ field: `workflow.${k}`, from: entity.workflow[k], to: workflow[k] }));
    const updated = await this.deps.models.LegalEntity.findOneAndUpdate({ tenantId: ctx.tenantId, _id: entity._id, version }, { $set: { workflow }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('business entity');
    if (changes.length) await this.record(ctx, meta, { action: 'legal_entity.updated', entityType: 'legal_entity', entityId: id, summary: `Changed workflow settings of "${entity.legalName}"`, changes });
    return this.getEntity(ctx, id);
  }

  /** Whether a new lock date moves the lock back (or removes it): that needs period.unlock and a fresh MFA check. */
  async periodLockDirection(ctx: TenantContext, id: string, lockDate: string | null): Promise<'forward' | 'backward' | 'same'> {
    const entity = await this.findEntity(ctx, id);
    const current = entity.periodLockDate;
    if (current === lockDate) return 'same';
    if (current === null) return 'forward';
    return lockDate !== null && lockDate > current ? 'forward' : 'backward';
  }

  /**
   * Period lock (FR-CO-05, workflows §10). Postings dated on or before the lock
   * date are refused. Moving it forward needs period.lock; moving it back or
   * removing it needs period.unlock. Both are audited with the reason.
   */
  async updatePeriodLock(ctx: TenantContext, id: string, input: { version: number; lockDate: string | null; reason: string }, meta: RequestMeta): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    const direction = await this.periodLockDirection(ctx, id, input.lockDate);
    if (direction === 'same') return this.getEntity(ctx, id);
    this.require(ctx, direction === 'forward' ? 'period.lock' : 'period.unlock', entity._id);
    if (input.lockDate && input.lockDate >= todayIST(this.now())) {
      throw new AppError('VALIDATION_FAILED', 'Lock a period that has ended: choose a date before today', [{ path: 'lockDate', message: 'Must be before today' }]);
    }
    const updated = await withTransaction(this.deps.models.LegalEntity.db, async (session) => {
      const res = await this.deps.models.LegalEntity.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: entity._id, version: input.version },
        { $set: { periodLockDate: input.lockDate }, $inc: { version: 1, periodLockCoordination: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!res) throw versionConflict('business entity');
      return res;
    });
    await this.record(ctx, meta, {
      action: direction === 'forward' ? 'period.locked' : 'period.unlocked',
      entityType: 'legal_entity',
      entityId: id,
      summary: input.lockDate ? `${direction === 'forward' ? 'Locked' : 'Moved the lock back to'} postings up to ${input.lockDate} for "${entity.legalName}"` : `Removed the period lock of "${entity.legalName}"`,
      changes: [
        { field: 'periodLockDate', from: entity.periodLockDate, to: input.lockDate },
        { field: 'reason', to: input.reason },
      ],
    });
    return this.getEntity(ctx, id);
  }

  async updateBankAccounts(ctx: TenantContext, id: string, input: { version: number; bankAccounts: Array<Omit<BankAccountDoc, 'id'>> }, meta: RequestMeta): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    this.require(ctx, 'settings.company', entity._id);
    const bankAccounts = input.bankAccounts.map((b, i) => ({ ...b, id: randomBytes(6).toString('hex'), isDefault: b.isDefault || (i === 0 && !input.bankAccounts.some((x) => x.isDefault)) }));
    const updated = await this.deps.models.LegalEntity.findOneAndUpdate({ tenantId: ctx.tenantId, _id: entity._id, version: input.version }, { $set: { bankAccounts }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('business entity');
    // Account numbers are not copied into the audit log.
    await this.record(ctx, meta, { action: 'legal_entity.updated', entityType: 'legal_entity', entityId: id, summary: `Updated bank accounts of "${entity.legalName}"`, changes: [{ field: 'bankAccounts', from: entity.bankAccounts.length, to: bankAccounts.length }] });
    return this.getEntity(ctx, id);
  }

  /**
   * Logo for printed documents (FR-CO-01). The file type is decided from the
   * bytes (PNG or JPEG only; SVG and anything else are refused) and the size is
   * limited. Documents numbered earlier keep the logo they were printed with.
   */
  async updateLogo(ctx: TenantContext, id: string, input: { version: number; image: { contentType: 'image/png' | 'image/jpeg'; data: string } | null }, meta: RequestMeta): Promise<LegalEntity> {
    const entity = await this.findEntity(ctx, id);
    this.require(ctx, 'settings.company', entity._id);
    let logo: LegalEntityDoc['logo'] = null;
    if (input.image) {
      if (!this.deps.storage.enabled) throw new AppError('BUSINESS_RULE', 'File storage is not set up on this server, so logos can’t be stored yet');
      const bytes = Buffer.from(input.image.data, 'base64');
      const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, [{ path: 'image', message }]);
      if (bytes.length === 0) throw invalid('The file is empty');
      if (bytes.length > LOGO_MAX_BYTES) throw invalid(`The logo can be at most ${Math.floor(LOGO_MAX_BYTES / 1000)} KB`);
      const info = inspectImage(bytes);
      if (!info) throw invalid('Use a PNG or JPEG image');
      if (info.contentType !== input.image.contentType) throw invalid('The file is not the type it claims to be');
      if (info.width < 16 || info.height < 16 || info.width > 2000 || info.height > 2000) throw invalid('Use an image between 16 and 2000 pixels on each side');
      const storageKey = this.deps.storage.newKey(info.contentType === 'image/png' ? 'png' : 'jpg');
      await this.deps.storage.put(storageKey, bytes);
      const [file] = await this.deps.models.File.create([{ tenantId: ctx.tenantId, storageKey, mime: info.contentType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), purpose: 'logo', createdAt: this.now() }]);
      if (!file) throw new Error('File not created');
      logo = { fileId: file._id, contentType: info.contentType, sizeBytes: bytes.length, width: info.width, height: info.height };
    }
    const updated = await this.deps.models.LegalEntity.findOneAndUpdate({ tenantId: ctx.tenantId, _id: entity._id, version: input.version }, { $set: { logo }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('business entity');
    await this.record(ctx, meta, {
      action: 'legal_entity.logo_changed',
      entityType: 'legal_entity',
      entityId: id,
      summary: logo ? `Set the logo of "${entity.legalName}"` : `Removed the logo of "${entity.legalName}"`,
      changes: [{ field: 'logo', from: entity.logo ? `${entity.logo.width}×${entity.logo.height}` : null, to: logo ? `${logo.width}×${logo.height}` : null }],
    });
    return this.getEntity(ctx, id);
  }

  // --------------------------------------------------------- registrations

  private toRegistration(r: GstRegistrationDoc): GstRegistration {
    return {
      id: r._id.toHexString(),
      legalEntityId: r.legalEntityId.toHexString(),
      gstin: r.gstin,
      stateCode: r.stateCode,
      registrationType: r.registrationType,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      address: r.address,
      label: r.label,
      version: r.version,
    };
  }

  async listRegistrations(ctx: TenantContext, entityId: string): Promise<GstRegistration[]> {
    const entity = await this.findEntity(ctx, entityId);
    const rows = await this.deps.models.GstRegistration.find({ tenantId: ctx.tenantId, legalEntityId: entity._id }).sort({ stateCode: 1, gstin: 1 }).lean();
    return rows.map((r) => this.toRegistration(r));
  }

  async createRegistration(
    ctx: TenantContext,
    entityId: string,
    input: { gstin: string; registrationType: 'regular' | 'composition'; effectiveFrom: string; effectiveTo: string | null; address: GstRegistrationDoc['address']; label: string },
    meta: RequestMeta,
  ): Promise<GstRegistration> {
    const entity = await this.findEntity(ctx, entityId);
    this.require(ctx, 'settings.company', entity._id);
    if (input.gstin.slice(2, 12) !== entity.pan) {
      throw new AppError('VALIDATION_FAILED', 'This GSTIN belongs to a different PAN', [{ path: 'gstin', message: `Expected PAN ${entity.pan} inside the GSTIN` }]);
    }
    const doc = { _id: new Types.ObjectId(), tenantId: ctx.tenantId, legalEntityId: entity._id, ...input, stateCode: input.gstin.slice(0, 2), version: 0 };
    try {
      await this.deps.models.GstRegistration.create([doc]);
    } catch (err) {
      if (isDuplicateKey(err)) throw new AppError('DUPLICATE', 'This GSTIN is already registered in this business', [{ path: 'gstin', message: 'Already added' }]);
      throw err;
    }
    await this.record(ctx, meta, {
      action: 'gst_registration.created',
      entityType: 'gst_registration',
      entityId: doc._id.toHexString(),
      summary: `Added GSTIN ${input.gstin} (${stateName(doc.stateCode) ?? doc.stateCode}) to "${entity.legalName}"`,
    });
    return this.toRegistration({ ...doc, createdAt: this.now(), updatedAt: this.now() });
  }

  private async findRegistration(ctx: TenantContext, id: string | Types.ObjectId) {
    const reg = await this.deps.models.GstRegistration.findOne({ tenantId: ctx.tenantId, _id: typeof id === 'string' ? new Types.ObjectId(id) : id }).lean();
    if (!reg) throw notFound('GST registration');
    await this.findEntity(ctx, reg.legalEntityId);
    return reg;
  }

  async updateRegistration(
    ctx: TenantContext,
    id: string,
    input: { version: number; registrationType?: 'regular' | 'composition' | undefined; effectiveTo?: string | null | undefined; address?: GstRegistrationDoc['address'] | undefined; label?: string | undefined },
    meta: RequestMeta,
  ): Promise<GstRegistration> {
    const reg = await this.findRegistration(ctx, id);
    this.require(ctx, 'settings.company', reg.legalEntityId);
    const { version, ...fields } = input;
    if (fields.address && fields.address.stateCode !== reg.stateCode) {
      throw new AppError('VALIDATION_FAILED', 'The address must be in the GSTIN’s state', [{ path: 'address.stateCode', message: 'Wrong state' }]);
    }
    if (fields.effectiveTo && fields.effectiveTo < reg.effectiveFrom) {
      throw new AppError('VALIDATION_FAILED', 'End date must be on or after the start date', [{ path: 'effectiveTo', message: 'Too early' }]);
    }
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const updated = await this.deps.models.GstRegistration.findOneAndUpdate({ tenantId: ctx.tenantId, _id: reg._id, version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('registration');
    const changes: AuditChange[] = Object.keys(set).map((field) =>
      field === 'address' ? { field } : { field, from: (reg as unknown as Record<string, unknown>)[field], to: set[field] },
    );
    if (changes.length) await this.record(ctx, meta, { action: 'gst_registration.updated', entityType: 'gst_registration', entityId: id, summary: `Updated GSTIN ${reg.gstin}`, changes });
    return this.toRegistration(updated);
  }

  // ---------------------------------------------------------------- series

  private async lockedSeriesIds(ctx: TenantContext, ids: Types.ObjectId[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const used = await this.deps.models.Sequence.find({ tenantId: ctx.tenantId, seriesId: trusted({ $in: ids }), issuedCount: trusted({ $gt: 0 }) }, { seriesId: 1 }).lean();
    return new Set(used.map((u) => u.seriesId.toHexString()));
  }

  private toSeries(s: DocumentSeriesDoc, locked: boolean): DocumentSeries {
    const format = { prefix: s.prefix, padding: s.padding };
    return {
      id: s._id.toHexString(),
      legalEntityId: s.legalEntityId.toHexString(),
      gstRegistrationId: s.gstRegistrationId?.toHexString() ?? null,
      docType: s.docType,
      name: s.name,
      prefix: s.prefix,
      padding: s.padding,
      startNumber: s.startNumber,
      isDefault: s.isDefault,
      active: s.active,
      locked,
      example: formatDocumentNumber(format, s.startNumber, financialYear(todayIST(this.now()))),
      capacity: seriesCapacity(format),
      version: s.version,
    };
  }

  async listSeries(ctx: TenantContext, entityId: string): Promise<DocumentSeries[]> {
    const entity = await this.findEntity(ctx, entityId);
    if (!this.canReadSettings(ctx, entity._id)) throw forbidden();
    const rows = await this.deps.models.DocumentSeries.find({ tenantId: ctx.tenantId, legalEntityId: entity._id }).sort({ docType: 1, name: 1 }).lean();
    const locked = await this.lockedSeriesIds(ctx, rows.map((r) => r._id));
    return rows.map((r) => this.toSeries(r, locked.has(r._id.toHexString())));
  }

  /**
   * Two series of the same document type and scope must never be able to produce
   * the same number in a financial year. With fixed-width numbers that means no
   * rendered prefix may be a prefix of another (e.g. "INV" and "INV1" could both
   * yield "INV1001").
   */
  private async assertNoCollision(ctx: TenantContext, scopeId: Types.ObjectId, docType: DocumentType, prefix: string, exceptId?: Types.ObjectId) {
    const others = await this.deps.models.DocumentSeries.find({ tenantId: ctx.tenantId, scopeId, docType }, { prefix: 1, name: 1 }).lean();
    const sample = (p: string) => p.split('{FY}').join('00-00').toUpperCase();
    const mine = sample(prefix);
    const clash = others.find((o) => !o._id.equals(exceptId ?? new Types.ObjectId()) && (sample(o.prefix).startsWith(mine) || mine.startsWith(sample(o.prefix))));
    if (clash) {
      throw new AppError('VALIDATION_FAILED', `This prefix could produce the same numbers as the series "${clash.name}". Choose a prefix that doesn’t start with, or isn’t the start of, the other one.`, [
        { path: 'prefix', message: 'Overlaps another series' },
      ]);
    }
  }

  async createSeries(
    ctx: TenantContext,
    input: { legalEntityId: string; gstRegistrationId: string | null; docType: DocumentType; name: string; prefix: string; padding: number; startNumber: number; isDefault: boolean },
    meta: RequestMeta,
  ): Promise<DocumentSeries> {
    const entity = await this.findEntity(ctx, input.legalEntityId);
    this.require(ctx, 'settings.company', entity._id);
    let scopeId = entity._id;
    if (DOCUMENT_TYPES[input.docType].scope === 'registration') {
      const reg = input.gstRegistrationId ? await this.deps.models.GstRegistration.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(input.gstRegistrationId), legalEntityId: entity._id }).lean() : null;
      if (!reg) throw new AppError('VALIDATION_FAILED', 'Choose a GST registration of this business entity', [{ path: 'gstRegistrationId', message: 'Unknown registration' }]);
      if (input.docType === 'tax_invoice' && reg.registrationType === 'composition') {
        throw new AppError('BUSINESS_RULE', 'Composition taxpayers issue bills of supply, not tax invoices (verify with your adviser: gst.md C-09)');
      }
      scopeId = reg._id;
    }
    await this.assertNoCollision(ctx, scopeId, input.docType, input.prefix);
    const doc = {
      _id: new Types.ObjectId(),
      tenantId: ctx.tenantId,
      legalEntityId: entity._id,
      gstRegistrationId: input.gstRegistrationId ? new Types.ObjectId(input.gstRegistrationId) : null,
      scopeId,
      docType: input.docType,
      name: input.name,
      prefix: input.prefix,
      padding: input.padding,
      startNumber: input.startNumber,
      isDefault: input.isDefault,
      active: true,
      version: 0,
    };
    // The first series of a type in a scope becomes the default.
    const existing = await this.deps.models.DocumentSeries.countDocuments({ tenantId: ctx.tenantId, scopeId, docType: input.docType, active: true });
    if (existing === 0) doc.isDefault = true;
    if (doc.isDefault) await this.deps.models.DocumentSeries.updateMany({ tenantId: ctx.tenantId, scopeId, docType: input.docType }, { $set: { isDefault: false }, $inc: { version: 1 } });
    await this.deps.models.DocumentSeries.create([doc]);
    const example = formatDocumentNumber(doc, doc.startNumber, financialYear(todayIST(this.now())));
    await this.record(ctx, meta, { action: 'series.created', entityType: 'document_series', entityId: doc._id.toHexString(), summary: `Added ${DOCUMENT_TYPES[doc.docType].label.toLowerCase()} series "${doc.name}" (${example})` });
    return this.toSeries({ ...doc, createdAt: this.now(), updatedAt: this.now() }, false);
  }

  async updateSeries(
    ctx: TenantContext,
    id: string,
    input: { version: number; name?: string | undefined; prefix?: string | undefined; padding?: number | undefined; startNumber?: number | undefined; isDefault?: boolean | undefined; active?: boolean | undefined },
    meta: RequestMeta,
  ): Promise<DocumentSeries> {
    const series = await this.deps.models.DocumentSeries.findOne({ tenantId: ctx.tenantId, _id: new Types.ObjectId(id) }).lean();
    if (!series) throw notFound('Document series');
    await this.findEntity(ctx, series.legalEntityId);
    this.require(ctx, 'settings.company', series.legalEntityId);
    const locked = (await this.lockedSeriesIds(ctx, [series._id])).size > 0;
    const formatChange = (['prefix', 'padding', 'startNumber'] as const).some((k) => input[k] !== undefined && input[k] !== series[k]);
    if (locked && formatChange) throw new AppError('BUSINESS_RULE', 'Numbers have been issued from this series, so its format can’t change. Create a new series instead.');
    const next = { prefix: input.prefix ?? series.prefix, padding: input.padding ?? series.padding, startNumber: input.startNumber ?? series.startNumber };
    const capacity = seriesCapacity(next);
    if (capacity === 0 || next.startNumber > capacity) {
      throw new AppError('VALIDATION_FAILED', 'Numbers must fit in 16 characters; shorten the prefix or padding', [{ path: 'prefix', message: `Rendered prefix is ${renderedPrefixLength(next.prefix)} characters` }]);
    }
    if (input.prefix !== undefined && input.prefix !== series.prefix) await this.assertNoCollision(ctx, series.scopeId, series.docType, input.prefix, series._id);
    const set = Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== 'version' && v !== undefined));
    if (set.isDefault === true) {
      await this.deps.models.DocumentSeries.updateMany({ tenantId: ctx.tenantId, scopeId: series.scopeId, docType: series.docType, _id: trusted({ $ne: series._id }) }, { $set: { isDefault: false }, $inc: { version: 1 } });
    }
    const updated = await this.deps.models.DocumentSeries.findOneAndUpdate({ tenantId: ctx.tenantId, _id: series._id, version: input.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('series');
    const changes: AuditChange[] = Object.keys(set).map((field) => ({ field, from: (series as unknown as Record<string, unknown>)[field], to: set[field] }));
    if (changes.length) await this.record(ctx, meta, { action: 'series.updated', entityType: 'document_series', entityId: id, summary: `Updated series "${updated.name}"`, changes });
    return this.toSeries(updated, locked);
  }
}
