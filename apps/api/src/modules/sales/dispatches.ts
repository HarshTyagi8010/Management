import { trusted, Types, type ClientSession } from 'mongoose';
import { dispatchInputSchema, SALES_STATUS_LABELS, type SalesDocument, type SalesDocStatus } from '@bizmgmt/contracts';
import { dec, DISPATCH_MACHINE, money, nextState, remaining } from '@bizmgmt/domain';
import type { LegalEntityDoc, SalesDocDoc, WarehouseDoc } from '../../models.js';
import { enqueue } from '../../platform/outbox.js';
import { withTransaction } from '../../platform/transactions.js';
import { toDecimal, todayIST, versionConflict } from '../../platform/values.js';
import { cogsJournalLines } from '../finance/journals.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import type { RequestMeta } from '../identity/identity.js';
import type { TenantContext } from '../tenancy/tenancy.js';
import type { PostLine } from '../inventory/ledger.js';
import { invalid, invalidState, qtyOf, rule, type DraftInput, type SalesCore } from './core.js';
import { applyToOrder, carryLines, checkLines, checkSourceOpen, OPEN_ORDER, sourceKind, type LineDelta } from './fulfilment.js';

type DispatchInput = ReturnType<typeof dispatchInputSchema.parse>;
type Patch = { version: number } & Partial<Record<keyof DispatchInput, unknown>>;

const label = (status: string) => SALES_STATUS_LABELS[status as SalesDocStatus]?.toLowerCase() ?? status;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Dispatches and delivery challans (FR-SAL-04, workflows.md §3), used when the
 * stock-out point is the dispatch: goods leave the warehouse here, at the
 * moving average cost (journal: cost of goods sold against inventory), using
 * up the order's reservation. Invoices raised from a dispatch move no stock
 * (FR-INV-10). A dispatch can be cancelled only while nothing on it is
 * invoiced; the goods then return at the cost they left with.
 */
export class DispatchService {
  constructor(private readonly core: SalesCore) {}

  private get models() {
    return this.core.deps.models;
  }

  private async context(ctx: TenantContext, input: { legalEntityId: string; warehouseId?: string | null | undefined; gstRegistrationId: string }) {
    const entity = await this.core.findEntity(ctx, input.legalEntityId, ['dispatch.post']);
    if (entity.workflow.stockOutPoint !== 'dispatch') throw rule('Goods leave with the invoice in your workflow (Settings › Workflow): there are no dispatches');
    if (!input.warehouseId) throw rule('Choose the warehouse', 'warehouseId');
    const warehouse = await this.core.findWarehouse(ctx, input.warehouseId, entity._id, new Types.ObjectId(input.gstRegistrationId));
    this.core.requireInWarehouse(ctx, 'dispatch.post', warehouse);
    return { entity, warehouse };
  }

  /** Checks the lines against the order the dispatch is made from (if any) and the order's warehouse. */
  private async checkSource(ctx: TenantContext, doc: Pick<SalesDocDoc, 'source' | 'warehouseId'>, lines: SalesDocDoc['lines'], entity: LegalEntityDoc, session?: ClientSession): Promise<SalesDocDoc | null> {
    const kind = sourceKind('dispatch', doc.source);
    const order = doc.source ? await this.models.SalesOrder.findOne({ tenantId: ctx.tenantId, _id: doc.source.id }, null, session ? { session } : {}).lean() : null;
    if (doc.source && !order) throw new Error('Source order missing');
    if (kind && order) {
      checkSourceOpen(kind, order);
      if (!order.warehouseId || !doc.warehouseId?.equals(order.warehouseId)) throw rule('Goods for this order are reserved in its warehouse: dispatch them from there', 'warehouseId');
    }
    checkLines(kind, lines, order, entity.workflow.stockOutPoint, 'dispatch');
    return order;
  }

  /**
   * Lines without a price take it from the order line they come from, else the
   * draft's own line for the same item, else the item's sale price.
   */
  private async withPrices(ctx: TenantContext, lines: DispatchInput['lines'], source: SalesDocDoc | null, existing: SalesDocDoc | null): Promise<DraftInput['lines']> {
    const missing = lines.filter((l) => l.unitPrice === undefined).map((l) => new Types.ObjectId(l.itemId));
    const items = missing.length ? await this.models.Item.find({ tenantId: ctx.tenantId, _id: trusted({ $in: missing }) }, { salePrice: 1, sku: 1 }).lean() : [];
    return lines.map((l, i) => {
      if (l.unitPrice !== undefined) return { itemId: l.itemId, qty: l.qty, unitPrice: l.unitPrice, discount: l.discount ?? null, sourceLineId: l.sourceLineId };
      const from = (l.sourceLineId ? source?.lines.find((o) => o.lineId === l.sourceLineId) : null) ?? existing?.lines.find((o) => (l.sourceLineId ? o.sourceLineId === l.sourceLineId : o.itemId.toHexString() === l.itemId));
      if (from) return { itemId: l.itemId, qty: l.qty, unitPrice: from.unitPrice.toString(), discount: l.discount ?? (from.discount ? { type: from.discount.type, value: from.discount.value.toString() } : null), sourceLineId: l.sourceLineId };
      const price = items.find((it) => it._id.toHexString() === l.itemId)?.salePrice;
      if (!price) throw invalid(`lines.${i}.unitPrice`, 'Enter a price: this item has no sale price');
      return { itemId: l.itemId, qty: l.qty, unitPrice: price.toString(), discount: l.discount ?? null, sourceLineId: l.sourceLineId };
    });
  }

  async create(ctx: TenantContext, input: DispatchInput, meta: RequestMeta): Promise<SalesDocument> {
    const { entity } = await this.context(ctx, input);
    this.core.checkDate(entity, input.docDate, true);
    const c = await this.core.compute(ctx, 'dispatch', { ...input, lines: await this.withPrices(ctx, input.lines, null, null) });
    await this.checkSource(ctx, { source: null, warehouseId: c.fields.warehouseId }, c.fields.lines, entity);
    const doc = this.core.newDraft(ctx, 'dispatch', c);
    await this.models.Dispatch.create([doc]);
    await this.core.audit(ctx, meta, doc, 'dispatch.created', `Drafted dispatch for ${doc.partyName}`);
    return this.core.toResponse(ctx, doc);
  }

  async get(ctx: TenantContext, id: string) {
    return this.core.toResponse(ctx, await this.core.findDoc(ctx, 'dispatch', id));
  }

  async update(ctx: TenantContext, id: string, patch: Patch, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'dispatch', id);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be edited');
    const { version, ...fields } = patch;
    const merged = dispatchInputSchema.parse({ ...this.core.inputOf(doc), ...defined(fields) });
    const { entity } = await this.context(ctx, merged);
    this.core.checkDate(entity, merged.docDate, true);
    const order = doc.source ? await this.models.SalesOrder.findOne({ tenantId: ctx.tenantId, _id: doc.source.id }).lean() : null;
    const c = await this.core.compute(ctx, 'dispatch', { ...merged, lines: await this.withPrices(ctx, merged.lines, order, doc) });
    await this.checkSource(ctx, { source: doc.source, warehouseId: c.fields.warehouseId }, c.fields.lines, entity);
    const saved = await this.core.saveDraft(ctx, doc, version, c.fields);
    await this.core.audit(ctx, meta, doc, 'dispatch.updated', `Edited draft dispatch for ${saved.partyName}`, Object.keys(defined(fields)).map((field) => ({ field })));
    return this.core.toResponse(ctx, saved);
  }

  /** Stock out (FR-SAL-04): number, freeze, move stock, use up the reservation, post cost of goods sold, queue the challan. */
  async dispatch(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'dispatch', id);
    if (!nextState(DISPATCH_MACHINE, doc.status, 'dispatch')) throw invalidState(`Only a draft can be dispatched; this one is ${label(doc.status)}`);
    if (doc.version !== version) throw versionConflict('dispatch');
    const { entity, warehouse } = await this.context(ctx, this.core.inputOf(doc));
    this.core.checkDate(entity, doc.docDate, true);
    const c = await this.core.compute(ctx, 'dispatch', this.core.inputOf(doc));
    await this.checkSource(ctx, doc, c.fields.lines, entity);
    const series = await this.core.prepareSeries(ctx, doc, 'delivery_challan', c.registration);
    await this.core.ledger.ensureRows(ctx.tenantId, entity._id, c.fields.lines.map((l) => ({ warehouseId: warehouse._id, itemId: l.itemId })));
    await this.core.deps.journals.ensureAccounts(ctx.tenantId, entity._id);
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.models });
      // The order is read again inside the transaction: a concurrent dispatch of the same order conflicts and retries.
      const order = await this.checkSource(ctx, doc, c.fields.lines, entity, session);
      const numbered = await this.core.takeNumber(session, ctx, series, doc.docDate);
      const posted = await this.core.ledger.post(this.postContext(ctx, session, entity, doc, numbered.number), this.stockOut(c.fields.lines, warehouse, order));
      const byLine = new Map(posted.map((p) => [p.sourceLineId, p]));
      const lines = c.fields.lines.map((l) => ({ ...l, unitCost: toDecimal(byLine.get(l.lineId)?.unitCost ?? '0'), costValue: toDecimal(byLine.get(l.lineId)?.value ?? '0') }));
      const cost = money(posted.reduce((acc, p) => acc.plus(dec(p.value)), dec('0')));
      await this.core.deps.journals.post(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, sourceType: 'dispatch', sourceId: doc._id, sourceNumber: numbered.number, narration: `Goods dispatched on ${numbered.number} to ${doc.partyName}`, lines: cogsJournalLines(cost), actorId: ctx.userId, now: this.core.now() });
      if (order) await this.updateOrder(ctx, session, order, lines, 'out');
      const updated = await this.models.Dispatch.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' },
        { $set: { ...c.fields, lines, ...numbered, ...this.core.printSnapshot(c.entity, 'dispatch'), warnings: [], status: 'dispatched', issuedBy: ctx.userId, issuedAt: this.core.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('dispatch');
      if (this.core.deps.storage.enabled && updated.templateVersion) {
        await enqueue(this.models, session, { tenantId: ctx.tenantId, type: 'document.render', aggregateId: doc._id, payload: { docType: 'dispatch', docId: doc._id.toHexString(), templateVersion: updated.templateVersion }, now: this.core.now() });
      }
      await this.core.audit(ctx, meta, doc, 'dispatch.dispatched', `Dispatched ${numbered.number} from ${warehouse.code} to ${doc.partyName}${order ? ` (order ${order.number})` : ''}`, [{ field: 'status', from: 'draft', to: 'dispatched' }], session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  private postContext(ctx: TenantContext, session: ClientSession, entity: LegalEntityDoc, doc: SalesDocDoc, number: string) {
    return { session, tenantId: ctx.tenantId, legalEntityId: entity._id, allowNegative: entity.workflow.allowNegativeStock, docDate: doc.docDate, sourceType: 'dispatch' as const, sourceId: doc._id, sourceNumber: number, actorId: ctx.userId, now: this.core.now() };
  }

  /** Stock-out lines; an order line's reservation is used up as its goods leave. */
  private stockOut(lines: SalesDocDoc['lines'], warehouse: WarehouseDoc, order: SalesDocDoc | null): PostLine[] {
    return lines.map((l) => {
      const reserved = order?.lines.find((o) => o.lineId === l.sourceLineId)?.reservedQty;
      const consume = reserved ? dec(qtyOf(reserved)).lessThan(dec(l.qty.toString())) ? qtyOf(reserved) : l.qty.toString() : undefined;
      return { warehouseId: warehouse._id, itemId: l.itemId, label: l.item.sku, qty: l.qty.toString(), kind: 'issue', sourceLineId: l.lineId, effect: { type: 'issue' }, consumeReserved: consume };
    });
  }

  /** Fulfilment on the order: out = dispatched (reservation used up), back = the dispatch was cancelled (re-reserved while the order is open). */
  private async updateOrder(ctx: TenantContext, session: ClientSession, order: SalesDocDoc, lines: SalesDocDoc['lines'], direction: 'out' | 'back') {
    const open = OPEN_ORDER.includes(order.status) || order.status === 'fulfilled';
    const deltas = new Map<string, LineDelta>();
    for (const l of lines) {
      if (!l.sourceLineId) continue;
      const o = order.lines.find((x) => x.lineId === l.sourceLineId);
      if (!o) throw new Error('Order line missing');
      const qty = l.qty.toString();
      if (direction === 'out') {
        const used = dec(qtyOf(o.reservedQty)).lessThan(dec(qty)) ? qtyOf(o.reservedQty) : qty;
        deltas.set(o.lineId, { fulfilled: qty, reserved: `-${used}` });
      } else {
        deltas.set(o.lineId, { fulfilled: `-${qty}`, ...(open ? { reserved: qty } : {}) });
        if (open && order.warehouseId) await this.core.ledger.reserve({ session, tenantId: ctx.tenantId, allowNegative: true }, { warehouseId: order.warehouseId, itemId: l.itemId, label: l.item.sku, qty, sourceLineId: o.lineId });
      }
    }
    const next = applyToOrder(order, deltas);
    const res = await this.models.SalesOrder.updateOne({ tenantId: ctx.tenantId, _id: order._id, version: order.version }, { $set: { lines: next.lines, status: next.status }, $inc: { version: 1 } }, { session });
    if (res.matchedCount !== 1) throw versionConflict('sales order');
  }

  /** Stock returns at the cost it left with; the cost-of-goods journal is reversed; the order is reopened for those quantities. */
  async cancel(ctx: TenantContext, id: string, input: { version: number; reason: string }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'dispatch', id);
    if (!nextState(DISPATCH_MACHINE, doc.status, 'cancel')) throw invalidState(doc.status === 'partially_invoiced' || doc.status === 'invoiced' ? 'Goods on this dispatch have been invoiced: cancel those invoices first' : `Only a dispatched dispatch can be cancelled; this one is ${label(doc.status)}`);
    if (doc.version !== input.version) throw versionConflict('dispatch');
    const { entity, warehouse } = await this.context(ctx, this.core.inputOf(doc));
    // The reversal is dated like the dispatch, so its period must still be open.
    this.core.checkDate(entity, doc.docDate, true);
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      const current = await this.models.Dispatch.findOne({ tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'dispatched' }, null, { session }).lean();
      if (!current || current.lines.some((l) => !dec(qtyOf(l.invoicedQty)).isZero())) throw versionConflict('dispatch');
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: current.docDate, models: this.models });
      const number = current.number ?? '';
      const outs = await this.models.StockMovement.find({ tenantId: ctx.tenantId, sourceType: 'dispatch', sourceId: doc._id, kind: 'issue', reversalOf: null }, { sourceLineId: 1 }, { session }).lean();
      const outByLine = new Map(outs.map((m) => [m.sourceLineId, m._id]));
      await this.core.ledger.post(
        this.postContext(ctx, session, entity, current, number),
        current.lines.map((l) => {
          const original = outByLine.get(l.lineId);
          if (!original) throw new Error(`Dispatch ${number} line ${l.lineId} has no stock movement`);
          return { warehouseId: warehouse._id, itemId: l.itemId, label: l.item.sku, qty: l.qty.toString(), kind: 'issue', sourceLineId: l.lineId, effect: { type: 'restore', value: l.costValue?.toString() ?? '0.00', reversalOf: original } };
        }),
      );
      await this.core.deps.journals.reverse(session, { tenantId: ctx.tenantId, sourceType: 'dispatch', sourceId: doc._id, docDate: current.docDate, narration: `Cancelled dispatch ${number}: ${input.reason}`, actorId: ctx.userId, now: this.core.now() });
      if (current.source) {
        const order = await this.models.SalesOrder.findOne({ tenantId: ctx.tenantId, _id: current.source.id }, null, { session }).lean();
        if (!order) throw new Error('Source order missing');
        await this.updateOrder(ctx, session, order, current.lines, 'back');
      }
      const updated = await this.models.Dispatch.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'dispatched' },
        { $set: { status: 'cancelled', cancelledBy: ctx.userId, cancelledAt: this.core.now(), cancelReason: input.reason }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('dispatch');
      await this.core.audit(ctx, meta, doc, 'dispatch.cancelled', `Cancelled dispatch ${number}; goods returned to ${warehouse.code}`, [{ field: 'status', from: 'dispatched', to: 'cancelled' }, { field: 'reason', to: input.reason }], session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  async discard(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'dispatch', id);
    await this.context(ctx, this.core.inputOf(doc));
    if (!nextState(DISPATCH_MACHINE, doc.status, 'discard')) throw invalidState('Only drafts can be discarded');
    const updated = await this.models.Dispatch.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: { status: 'discarded' }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('dispatch');
    await this.core.audit(ctx, meta, doc, 'dispatch.discarded', `Discarded draft dispatch for ${doc.partyName}`, [{ field: 'status', from: 'draft', to: 'discarded' }]);
    return this.core.toResponse(ctx, updated);
  }

  /** A draft invoice for what on the dispatch is not yet invoiced. */
  async makeInvoice(ctx: TenantContext, id: string, meta: RequestMeta): Promise<SalesDocument> {
    const dispatch = await this.core.findDoc(ctx, 'dispatch', id);
    this.core.require(ctx, 'invoice.edit', dispatch.legalEntityId);
    if (dispatch.status !== 'dispatched' && dispatch.status !== 'partially_invoiced') throw invalidState(`Dispatch ${dispatch.number ?? ''} is ${label(dispatch.status)}: there is nothing to invoice`.replace('  ', ' '));
    const { lines, documentDiscount } = carryLines(dispatch, (l) => remaining(l.qty.toString(), qtyOf(l.invoicedQty)));
    if (!lines.length) throw rule('Everything on this dispatch has been invoiced');
    const { lines: _l, documentDiscount: _d, transport: _t, ...rest } = this.core.inputOf(dispatch);
    const input: DraftInput = { ...rest, docDate: todayIST(this.core.now()), seriesId: null, dueDate: null, lines, documentDiscount };
    const c = await this.core.compute(ctx, 'sales_invoice', input);
    const draft = this.core.newDraft(ctx, 'sales_invoice', c, { source: { type: 'dispatch', id: dispatch._id } });
    await this.models.SalesInvoice.create([draft]);
    await this.core.audit(ctx, meta, draft, 'sales_invoice.created', `Drafted invoice from dispatch ${dispatch.number} for ${draft.partyName}`);
    return this.core.toResponse(ctx, draft);
  }
}
