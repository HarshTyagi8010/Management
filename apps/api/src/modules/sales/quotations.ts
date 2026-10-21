import { trusted, type Types } from 'mongoose';
import { quotationInputSchema, SALES_STATUS_LABELS, type SalesDocument, type SalesDocStatus } from '@bizmgmt/contracts';
import { nextState, QUOTATION_MACHINE } from '@bizmgmt/domain';
import type { SalesDocDoc } from '../../models.js';
import { enqueue } from '../../platform/outbox.js';
import { withTransaction } from '../../platform/transactions.js';
import { todayIST, versionConflict } from '../../platform/values.js';
import type { RequestMeta } from '../identity/identity.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';
import { forbidden, invalid, invalidState, newLineId, type DraftInput, type SalesCore } from './core.js';

type QuotationInput = ReturnType<typeof quotationInputSchema.parse>;
type Patch = { version: number } & Partial<Record<keyof QuotationInput, unknown>>;

const label = (status: string) => SALES_STATUS_LABELS[status as SalesDocStatus]?.toLowerCase() ?? status;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Quotations and proforma invoices (FR-SAL-01/02, workflows.md §1): numbered
 * when sent; no stock or ledger effect. A sent quotation is never edited: a
 * revision replaces it and the original is kept as it was sent.
 */
export class QuotationService {
  constructor(private readonly core: SalesCore) {}

  private get models() {
    return this.core.deps.models;
  }

  async create(ctx: TenantContext, input: QuotationInput, meta: RequestMeta): Promise<SalesDocument> {
    const entity = await this.core.findEntity(ctx, input.legalEntityId, ['quotation.edit']);
    this.core.require(ctx, 'quotation.edit', entity._id);
    this.core.checkDate(entity, input.docDate, false);
    if (input.lines.some((l) => l.sourceLineId)) throw invalid('lines', 'Quotation lines are not linked to other documents');
    const c = await this.core.compute(ctx, 'quotation', input);
    const doc = this.core.newDraft(ctx, 'quotation', c);
    await this.models.Quotation.create([doc]);
    await this.core.audit(ctx, meta, doc, 'quotation.created', `Drafted ${doc.documentKind === 'proforma_invoice' ? 'proforma invoice' : 'quotation'} for ${doc.partyName}`);
    return this.core.toResponse(ctx, doc);
  }

  async get(ctx: TenantContext, id: string) {
    return this.core.toResponse(ctx, await this.core.findDoc(ctx, 'quotation', id));
  }

  async update(ctx: TenantContext, id: string, patch: Patch, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'quotation', id);
    this.core.require(ctx, 'quotation.edit', doc.legalEntityId);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be edited. Revise a sent quotation instead.');
    const { version, ...fields } = patch;
    const merged = quotationInputSchema.parse({ ...this.core.inputOf(doc), ...defined(fields) });
    if (merged.lines.some((l) => l.sourceLineId)) throw invalid('lines', 'Quotation lines are not linked to other documents');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['quotation.edit']);
    this.core.checkDate(entity, merged.docDate, false);
    const c = await this.core.compute(ctx, 'quotation', merged);
    const saved = await this.core.saveDraft(ctx, doc, version, c.fields);
    await this.core.audit(ctx, meta, doc, 'quotation.updated', `Edited draft quotation for ${saved.partyName}`, Object.keys(defined(fields)).map((field) => ({ field })));
    return this.core.toResponse(ctx, saved);
  }

  /** Numbers the quotation, freezes its figures and details, and queues its PDF. */
  async send(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'quotation', id);
    this.core.require(ctx, 'quotation.issue', doc.legalEntityId);
    if (!nextState(QUOTATION_MACHINE, doc.status, 'send')) throw invalidState(`Only a draft can be sent; this one is ${label(doc.status)}`);
    if (doc.version !== version) throw versionConflict('quotation');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['quotation.issue']);
    this.core.checkDate(entity, doc.docDate, false);
    if (doc.validUntil && doc.validUntil < todayIST(this.core.now())) throw invalid('validUntil', 'The quotation would already have expired. Change “Valid until” first.');
    // Figures are recomputed from the current rates and masters, then frozen.
    const c = await this.core.compute(ctx, 'quotation', this.core.inputOf(doc));
    const series = await this.core.prepareSeries(ctx, doc, c.fields.documentKind, c.registration);
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      const numbered = await this.core.takeNumber(session, ctx, series, doc.docDate);
      const updated = await this.models.Quotation.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' },
        { $set: { ...c.fields, ...numbered, ...this.core.printSnapshot(c.entity, 'quotation'), warnings: [], status: 'sent', issuedBy: ctx.userId, issuedAt: this.core.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('quotation');
      await this.queuePdf(ctx, session, updated);
      await this.core.audit(ctx, meta, doc, 'quotation.sent', `Sent ${updated.documentKind === 'proforma_invoice' ? 'proforma invoice' : 'quotation'} ${numbered.number} to ${updated.partyName}`, [{ field: 'status', from: 'draft', to: 'sent' }], session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  private async queuePdf(ctx: TenantContext, session: Parameters<typeof enqueue>[1], doc: SalesDocDoc) {
    if (!this.core.deps.storage.enabled || !doc.templateVersion) return;
    await enqueue(this.models, session, { tenantId: ctx.tenantId, type: 'document.render', aggregateId: doc._id, payload: { docType: 'quotation', docId: doc._id.toHexString(), templateVersion: doc.templateVersion }, now: this.core.now() });
  }

  /** Accept, reject or discard: a status change only. */
  async decide(ctx: TenantContext, id: string, action: 'accept' | 'reject' | 'discard', version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'quotation', id);
    this.core.require(ctx, 'quotation.edit', doc.legalEntityId);
    const to = nextState(QUOTATION_MACHINE, doc.status, action);
    if (!to) throw invalidState(action === 'discard' ? 'Only drafts can be discarded' : `Only a sent quotation can be ${action}ed; this one is ${label(doc.status)}`);
    const updated = await this.models.Quotation.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: doc.status }, { $set: { status: to }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('quotation');
    const action_ = ({ accept: 'quotation.accepted', reject: 'quotation.rejected', discard: 'quotation.discarded' } as const)[action];
    await this.core.audit(ctx, meta, doc, action_, `${{ accept: 'Marked accepted', reject: 'Marked rejected', discard: 'Discarded draft' }[action]}: quotation ${doc.number ?? ''} for ${doc.partyName}`.replace('  ', ' '), [{ field: 'status', from: doc.status, to }]);
    return this.core.toResponse(ctx, updated);
  }

  /** A sent quotation is kept as sent; a new draft revision takes its place (workflows.md §1). */
  async revise(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'quotation', id);
    this.core.require(ctx, 'quotation.edit', doc.legalEntityId);
    if (!nextState(QUOTATION_MACHINE, doc.status, 'revise')) throw invalidState(`Only a sent quotation can be revised; this one is ${label(doc.status)}`);
    if (doc.version !== version) throw versionConflict('quotation');
    const input = { ...this.core.inputOf(doc), docDate: todayIST(this.core.now()), validUntil: doc.validUntil && doc.validUntil >= todayIST(this.core.now()) ? doc.validUntil : null };
    const c = await this.core.compute(ctx, 'quotation', input);
    const draft = this.core.newDraft(ctx, 'quotation', c, { revision: doc.revision + 1, revisionOf: doc._id });
    await withTransaction(this.core.deps.connection, async (session) => {
      const updated = await this.models.Quotation.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'sent' }, { $set: { status: 'revised' }, $inc: { version: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!updated) throw versionConflict('quotation');
      await this.models.Quotation.create([draft], { session });
      await this.core.audit(ctx, meta, doc, 'quotation.revised', `Revised quotation ${doc.number}: revision ${draft.revision} drafted`, [{ field: 'status', from: 'sent', to: 'revised' }], session);
    });
    return this.core.toResponse(ctx, draft);
  }

  /** An accepted quotation becomes a draft sales order or invoice with the same customer, terms and lines. */
  async convert(ctx: TenantContext, id: string, input: { version: number; to: 'sales_order' | 'sales_invoice' }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'quotation', id);
    this.core.require(ctx, 'quotation.edit', doc.legalEntityId);
    if (!canInEntity(ctx, input.to === 'sales_order' ? 'salesorder.edit' : 'invoice.edit', doc.legalEntityId)) throw forbidden();
    if (!nextState(QUOTATION_MACHINE, doc.status, 'convert')) throw invalidState(`Only an accepted quotation can be converted; this one is ${label(doc.status)}`);
    if (doc.version !== input.version) throw versionConflict('quotation');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['quotation.edit']);
    const base = this.core.inputOf(doc);
    const { kind: _kind, validUntil: _validUntil, ...common } = base;
    const draftInput: DraftInput = { ...common, docDate: todayIST(this.core.now()), seriesId: null, warehouseId: null, ...(input.to === 'sales_order' ? { expectedDate: null } : { dueDate: null }) };
    if (input.to === 'sales_invoice' && entity.workflow.stockOutPoint === 'dispatch' && doc.lines.some((l) => l.item.type === 'stock')) {
      throw invalidState('Goods leave with a dispatch in your workflow: convert the quotation to a sales order, then dispatch and invoice it');
    }
    const c = await this.core.compute(ctx, input.to, draftInput);
    const draft = this.core.newDraft(ctx, input.to, c, { source: { type: 'quotation', id: doc._id }, lines: c.fields.lines.map((l) => ({ ...l, lineId: newLineId() })) });
    await withTransaction(this.core.deps.connection, async (session) => {
      const updated = await this.models.Quotation.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'accepted' }, { $set: { status: 'converted' }, $inc: { version: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!updated) throw versionConflict('quotation');
      await this.core.model(input.to).create([draft], { session });
      await this.core.audit(ctx, meta, doc, 'quotation.converted', `Converted quotation ${doc.number} to a draft ${input.to === 'sales_order' ? 'sales order' : 'invoice'}`, [{ field: 'status', from: 'accepted', to: 'converted' }, { field: 'convertedTo', to: draft._id.toHexString() }], session);
      await this.core.audit(ctx, meta, draft, input.to === 'sales_order' ? 'sales_order.created' : 'sales_invoice.created', `Drafted from quotation ${doc.number} for ${draft.partyName}`, [], session);
    });
    return this.core.toResponse(ctx, draft);
  }

  /** Daily: sent quotations past their validity become expired (workflows.md §1). Returns how many. */
  static async expire(models: SalesCore['deps']['models'], tenantId: Types.ObjectId, today: string): Promise<number> {
    const res = await models.Quotation.updateMany({ tenantId, status: 'sent', validUntil: trusted({ $ne: null, $lt: today }) }, { $set: { status: 'expired' }, $inc: { version: 1 } });
    return res.modifiedCount;
  }
}
