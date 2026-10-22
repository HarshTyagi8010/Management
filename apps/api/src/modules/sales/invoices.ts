import { Types, type ClientSession } from 'mongoose';
import { salesInvoiceInputSchema, SALES_STATUS_LABELS, turnoverRules, type AuditChange, type SalesDocument, type SalesDocStatus } from '@bizmgmt/contracts';
import { addDays, dec, money, nextState, SALES_INVOICE_MACHINE } from '@bizmgmt/domain';
import type { LegalEntityDoc, SalesDocDoc, WarehouseDoc } from '../../models.js';
import { enqueue } from '../../platform/outbox.js';
import { withTransaction } from '../../platform/transactions.js';
import { toDecimal, versionConflict } from '../../platform/values.js';
import { cogsJournalLines, salesInvoiceJournalLines } from '../finance/journals.js';
import { assertPeriodOpen } from '../finance/period-lock.js';
import type { RequestMeta } from '../identity/identity.js';
import type { PostLine } from '../inventory/ledger.js';
import type { TenantContext } from '../tenancy/tenancy.js';
import { AppError } from '../../errors.js';
import { invalidState, qtyOf, rule, totalsOf, type Computation, type SalesCore } from './core.js';
import { applyToDispatch, applyToOrder, checkLines, checkSourceOpen, OPEN_ORDER, sourceKind, type LineDelta } from './fulfilment.js';

type InvoiceInput = ReturnType<typeof salesInvoiceInputSchema.parse>;
type Patch = { version: number } & Partial<Record<keyof InvoiceInput, unknown>>;

const label = (status: string) => SALES_STATUS_LABELS[status as SalesDocStatus]?.toLowerCase() ?? status;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
/** Rule 46: an unregistered recipient's delivery address and state are required from this taxable value. */
const UNREGISTERED_ADDRESS_THRESHOLD = '50000';

/**
 * Tax invoices and bills of supply (FR-SAL-05/06/07, workflows.md §4).
 *
 * Issuing is one transaction: the next number of the series, the frozen
 * snapshot (figures, seller, buyer, items, logo, bank account), stock out when
 * the invoice is the stock-out point (using up the order's reservation), the
 * sales journal (and cost of goods sold), fulfilment on the order or dispatch,
 * the PDF in the outbox, and the audit entry. An issued invoice is never
 * edited; cancelling keeps its number and reverses its journal and stock.
 */
export class SalesInvoiceService {
  constructor(private readonly core: SalesCore) {}

  private get models() {
    return this.core.deps.models;
  }

  /** Reads the source document and checks the invoice's lines against it and the stock-out point. */
  private async checkSource(ctx: TenantContext, doc: Pick<SalesDocDoc, 'source' | 'warehouseId'>, lines: SalesDocDoc['lines'], entity: LegalEntityDoc, session?: ClientSession): Promise<SalesDocDoc | null> {
    const kind = sourceKind('sales_invoice', doc.source);
    const model = doc.source?.type === 'dispatch' ? this.models.Dispatch : this.models.SalesOrder;
    // A quotation is only where the draft came from; it is not drawn on.
    const source = doc.source && doc.source.type !== 'quotation' ? await model.findOne({ tenantId: ctx.tenantId, _id: doc.source.id }, null, session ? { session } : {}).lean() : null;
    const effectiveKind = doc.source?.type === 'quotation' ? null : kind;
    if (effectiveKind && !source) throw new Error('Source document missing');
    if (effectiveKind && source) checkSourceOpen(effectiveKind, source);
    checkLines(effectiveKind, lines, source, entity.workflow.stockOutPoint, 'sales_invoice');
    if (effectiveKind === 'invoice_from_order' && source && entity.workflow.stockOutPoint === 'invoice' && lines.some((l) => l.sourceLineId && l.item.type === 'stock') && !doc.warehouseId?.equals(source.warehouseId ?? new Types.ObjectId())) {
      throw rule('Goods for this order are reserved in its warehouse: invoice them from there', 'warehouseId');
    }
    return source;
  }

  async create(ctx: TenantContext, input: InvoiceInput, meta: RequestMeta): Promise<SalesDocument> {
    const entity = await this.core.findEntity(ctx, input.legalEntityId, ['invoice.edit']);
    this.core.require(ctx, 'invoice.edit', entity._id);
    this.core.checkDate(entity, input.docDate, true);
    const c = await this.core.compute(ctx, 'sales_invoice', input);
    await this.checkSource(ctx, { source: null, warehouseId: c.fields.warehouseId }, c.fields.lines, entity);
    const doc = this.core.newDraft(ctx, 'sales_invoice', c);
    await this.models.SalesInvoice.create([doc]);
    await this.core.audit(ctx, meta, doc, 'sales_invoice.created', `Drafted invoice for ${doc.partyName}`);
    return this.core.toResponse(ctx, doc);
  }

  async get(ctx: TenantContext, id: string) {
    return this.core.toResponse(ctx, await this.core.findDoc(ctx, 'sales_invoice', id));
  }

  async update(ctx: TenantContext, id: string, patch: Patch, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_invoice', id);
    this.core.require(ctx, 'invoice.edit', doc.legalEntityId);
    if (doc.status !== 'draft') throw invalidState('An issued invoice can’t be edited. Cancel it, or issue a credit note (Phase 9).');
    const { version, ...fields } = patch;
    const merged = salesInvoiceInputSchema.parse({ ...this.core.inputOf(doc), ...defined(fields) });
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['invoice.edit']);
    this.core.checkDate(entity, merged.docDate, true);
    const c = await this.core.compute(ctx, 'sales_invoice', merged);
    await this.checkSource(ctx, { source: doc.source, warehouseId: c.fields.warehouseId }, c.fields.lines, entity);
    const saved = await this.core.saveDraft(ctx, doc, version, c.fields);
    await this.core.audit(ctx, meta, doc, 'sales_invoice.updated', `Edited draft invoice for ${saved.partyName}`, Object.keys(defined(fields)).map((field) => ({ field })));
    return this.core.toResponse(ctx, saved);
  }

  /** Issue-time particulars (gst.md GST-02/03/04): blocks what the preview only warned about. */
  private checkParticulars(c: Computation) {
    const f = c.fields;
    const b2b = f.buyer.gstin !== null;
    if (b2b && !f.buyer.billingAddress) throw rule('A registered customer’s address must be on the invoice: add an address to the customer', 'billingAddressId');
    if (!b2b && dec(f.totals.taxable.toString()).greaterThanOrEqualTo(dec(UNREGISTERED_ADDRESS_THRESHOLD)) && (!f.buyer.billingAddress || !f.buyer.shippingAddress)) {
      throw rule('For an unregistered customer and a taxable value of ₹50,000 or more, the invoice needs their address and the delivery address with its state (Rule 46)', 'billingAddressId');
    }
    if (f.documentKind === 'tax_invoice') {
      const band = c.entity.turnoverBand;
      const minDigits = turnoverRules(band).hsnMinDigits;
      // Smaller businesses (up to ₹5 crore) may leave HSN off B2C invoices (GST-04).
      if (b2b || band !== 'up_to_5cr') {
        const short = f.lines.filter((l) => l.item.hsnSac.length < minDigits).map((l) => l.item.sku);
        if (short.length) throw rule(`HSN/SAC must have at least ${minDigits} digits on this invoice (GST-04): fix ${short.join(', ')} under Items`, 'lines');
      }
    }
  }

  async issue(ctx: TenantContext, id: string, input: { version: number; expectedTotal?: string | undefined; overrideCreditLimit: boolean }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_invoice', id);
    this.core.require(ctx, 'invoice.issue', doc.legalEntityId);
    if (!nextState(SALES_INVOICE_MACHINE, doc.status, 'issue')) throw invalidState(`Only a draft can be issued; this invoice is ${label(doc.status)}`);
    if (doc.version !== input.version) throw versionConflict('invoice');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['invoice.issue']);
    this.core.checkDate(entity, doc.docDate, true);
    // Recomputed from current rates and masters; frozen from here on.
    const c = await this.core.compute(ctx, 'sales_invoice', this.core.inputOf(doc));
    const grand = c.fields.totals.grand.toString();
    if (input.expectedTotal !== undefined && !dec(input.expectedTotal).eq(dec(grand))) {
      throw new AppError('VERSION_CONFLICT', `The total is now ₹${grand}: rates or item details changed since you last saw this invoice. Review it, then issue again.`, [{ path: 'expectedTotal', message: grand }]);
    }
    this.checkParticulars(c);
    const atInvoice = entity.workflow.stockOutPoint === 'invoice';
    const stock = c.fields.lines.filter((l) => l.item.type === 'stock');
    let warehouse: WarehouseDoc | null = null;
    if (atInvoice && stock.length) {
      if (!c.warehouse) throw rule('Choose the warehouse the goods leave from', 'warehouseId');
      warehouse = c.warehouse;
      this.core.requireInWarehouse(ctx, 'invoice.issue', warehouse);
      await this.core.ledger.ensureRows(ctx.tenantId, entity._id, stock.map((l) => ({ warehouseId: warehouse!._id, itemId: l.itemId })));
    }
    await this.checkSource(ctx, doc, c.fields.lines, entity);
    const credit = await this.core.checkCredit(ctx, c.party, grand, input.overrideCreditLimit, entity._id);
    const series = await this.core.prepareSeries(ctx, doc, c.fields.documentKind, c.registration);
    await this.core.deps.journals.ensureAccounts(ctx.tenantId, entity._id);
    const dueDate = c.fields.dueDate ?? addDays(doc.docDate, c.party.paymentTermsDays ?? 0);
    const einvoiceStatus = c.fields.documentKind === 'tax_invoice' && c.fields.buyer.gstin && turnoverRules(entity.turnoverBand).eInvoiceApplicable ? 'not_submitted' : 'not_applicable';

    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: doc.docDate, models: this.models });
      const source = await this.checkSource(ctx, doc, c.fields.lines, entity, session);
      // The number first: if anything after it fails, the transaction rolls the counter back (AC-NUM-1).
      const numbered = await this.core.takeNumber(session, ctx, series, doc.docDate);
      const order = source?.docType === 'sales_order' ? source : null;
      const posted = warehouse ? await this.core.ledger.post(this.postContext(ctx, session, entity, doc, numbered.number), this.stockOut(stock, warehouse, order)) : [];
      const byLine = new Map(posted.map((p) => [p.sourceLineId, p]));
      const lines = c.fields.lines.map((l) => {
        const p = byLine.get(l.lineId);
        return p ? { ...l, unitCost: toDecimal(p.unitCost), costValue: toDecimal(p.value) } : l;
      });
      const cost = money(posted.reduce((acc, p) => acc.plus(dec(p.value)), dec('0')));
      await this.core.deps.journals.post(session, {
        tenantId: ctx.tenantId,
        legalEntityId: entity._id,
        docDate: doc.docDate,
        sourceType: 'sales_invoice',
        sourceId: doc._id,
        sourceNumber: numbered.number,
        narration: `${c.fields.documentKind === 'bill_of_supply' ? 'Bill of supply' : 'Tax invoice'} ${numbered.number} to ${doc.partyName}`,
        lines: [...salesInvoiceJournalLines(totalsOf(c.fields)), ...cogsJournalLines(cost)],
        actorId: ctx.userId,
        now: this.core.now(),
      });
      if (source) await this.updateSource(ctx, session, source, lines, entity, 'out', posted.length > 0);
      const updated = await this.models.SalesInvoice.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'draft' },
        {
          $set: {
            ...c.fields,
            lines,
            dueDate,
            ...numbered,
            ...this.core.printSnapshot(c.entity, 'sales_invoice'),
            warnings: [],
            status: 'issued',
            outstanding: c.fields.totals.grand,
            paymentStatus: 'unpaid',
            einvoiceStatus,
            issuedBy: ctx.userId,
            issuedAt: this.core.now(),
          },
          $inc: { version: 1 },
        },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('invoice');
      if (this.core.deps.storage.enabled && updated.templateVersion) {
        await enqueue(this.models, session, { tenantId: ctx.tenantId, type: 'document.render', aggregateId: doc._id, payload: { docType: 'sales_invoice', docId: doc._id.toHexString(), templateVersion: updated.templateVersion }, now: this.core.now() });
      }
      const changes: AuditChange[] = [{ field: 'status', from: 'draft', to: 'issued' }, { field: 'grand', to: grand }, ...(credit ? [credit] : [])];
      if (updated.placeOfSupplyOverridden) changes.push({ field: 'placeOfSupply', to: updated.placeOfSupply });
      await this.core.audit(ctx, meta, doc, 'sales_invoice.issued', `Issued ${c.fields.documentKind === 'bill_of_supply' ? 'bill of supply' : 'tax invoice'} ${numbered.number} to ${doc.partyName} for ₹${grand}`, changes, session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  private postContext(ctx: TenantContext, session: ClientSession, entity: LegalEntityDoc, doc: SalesDocDoc, number: string) {
    return { session, tenantId: ctx.tenantId, legalEntityId: entity._id, allowNegative: entity.workflow.allowNegativeStock, docDate: doc.docDate, sourceType: 'sales_invoice' as const, sourceId: doc._id, sourceNumber: number, actorId: ctx.userId, now: this.core.now() };
  }

  private stockOut(lines: SalesDocDoc['lines'], warehouse: WarehouseDoc, order: SalesDocDoc | null): PostLine[] {
    return lines.map((l) => {
      const reserved = order?.lines.find((o) => o.lineId === l.sourceLineId)?.reservedQty;
      const consume = reserved ? (dec(qtyOf(reserved)).lessThan(dec(l.qty.toString())) ? qtyOf(reserved) : l.qty.toString()) : undefined;
      return { warehouseId: warehouse._id, itemId: l.itemId, label: l.item.sku, qty: l.qty.toString(), kind: 'issue', sourceLineId: l.lineId, effect: { type: 'issue' }, consumeReserved: consume };
    });
  }

  /**
   * Fulfilment and invoicing on the source: out = issued, back = cancelled.
   * From a dispatch: its lines' invoiced quantities, and the order's through
   * them. From an order: invoiced, and fulfilled where the invoice is what
   * fulfils the line (all lines at the invoice stock-out point, non-stock
   * lines otherwise), with reservations used up or given back.
   */
  private async updateSource(ctx: TenantContext, session: ClientSession, source: SalesDocDoc, lines: SalesDocDoc['lines'], entity: LegalEntityDoc, direction: 'out' | 'back', movedStock: boolean) {
    const sign = (q: string) => (direction === 'out' ? q : `-${q}`);
    const linked = lines.filter((l) => l.sourceLineId);
    if (source.docType === 'dispatch') {
      const next = applyToDispatch(source, new Map(linked.map((l) => [l.sourceLineId ?? '', sign(l.qty.toString())])));
      const res = await this.models.Dispatch.updateOne({ tenantId: ctx.tenantId, _id: source._id, version: source.version }, { $set: { lines: next.lines, status: next.status }, $inc: { version: 1 } }, { session });
      if (res.matchedCount !== 1) throw versionConflict('dispatch');
      if (!source.source) return;
      const order = await this.models.SalesOrder.findOne({ tenantId: ctx.tenantId, _id: source.source.id }, null, { session }).lean();
      if (!order) throw new Error('Order of the dispatch missing');
      const deltas = new Map<string, LineDelta>();
      for (const l of linked) {
        const orderLineId = source.lines.find((d) => d.lineId === l.sourceLineId)?.sourceLineId;
        if (orderLineId) deltas.set(orderLineId, { invoiced: sign(l.qty.toString()) });
      }
      const o = applyToOrder(order, deltas);
      const r = await this.models.SalesOrder.updateOne({ tenantId: ctx.tenantId, _id: order._id, version: order.version }, { $set: { lines: o.lines, status: o.status }, $inc: { version: 1 } }, { session });
      if (r.matchedCount !== 1) throw versionConflict('sales order');
      return;
    }
    const open = OPEN_ORDER.includes(source.status) || source.status === 'fulfilled';
    const deltas = new Map<string, LineDelta>();
    for (const l of linked) {
      const o = source.lines.find((x) => x.lineId === l.sourceLineId);
      if (!o) throw new Error('Order line missing');
      const qty = l.qty.toString();
      const fulfils = entity.workflow.stockOutPoint === 'invoice' || o.item.type !== 'stock';
      const delta: LineDelta = { invoiced: sign(qty), ...(fulfils ? { fulfilled: sign(qty) } : {}) };
      if (movedStock && o.item.type === 'stock') {
        if (direction === 'out') {
          const used = dec(qtyOf(o.reservedQty)).lessThan(dec(qty)) ? qtyOf(o.reservedQty) : qty;
          delta.reserved = `-${used}`;
        } else if (open && source.warehouseId) {
          // The goods are back in stock and the order still wants them: hold them again.
          delta.reserved = qty;
          await this.core.ledger.reserve({ session, tenantId: ctx.tenantId, allowNegative: true }, { warehouseId: source.warehouseId, itemId: l.itemId, label: l.item.sku, qty, sourceLineId: o.lineId });
        }
      }
      deltas.set(o.lineId, delta);
    }
    const next = applyToOrder(source, deltas);
    const res = await this.models.SalesOrder.updateOne({ tenantId: ctx.tenantId, _id: source._id, version: source.version }, { $set: { lines: next.lines, status: next.status }, $inc: { version: 1 } }, { session });
    if (res.matchedCount !== 1) throw versionConflict('sales order');
  }

  /**
   * Cancelling keeps the number (FR-ADJ-04): the sales journal is reversed,
   * stock that left with the invoice returns at the cost it left with, and the
   * order or dispatch gets the quantities back. Not possible once receipts are
   * allocated or credit notes reference the invoice (Phase 9).
   */
  async cancel(ctx: TenantContext, id: string, input: { version: number; reason: string }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_invoice', id);
    this.core.require(ctx, 'invoice.cancel', doc.legalEntityId);
    if (!nextState(SALES_INVOICE_MACHINE, doc.status, 'cancel')) throw invalidState(`Only an issued invoice can be cancelled; this one is ${label(doc.status)}`);
    if (doc.version !== input.version) throw versionConflict('invoice');
    if (doc.paymentStatus && doc.paymentStatus !== 'unpaid') throw rule('Payments are allocated to this invoice: remove the allocations first');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['invoice.cancel']);
    // The reversal is dated like the invoice, so its period must still be open.
    this.core.checkDate(entity, doc.docDate, true);
    const movedStock = doc.lines.some((l) => l.costValue !== null);
    const warehouse = movedStock && doc.warehouseId ? await this.models.Warehouse.findOne({ tenantId: ctx.tenantId, _id: doc.warehouseId }).lean() : null;
    if (movedStock && !warehouse) throw new Error('Invoice warehouse missing');
    if (warehouse) await this.core.ledger.ensureRows(ctx.tenantId, entity._id, doc.lines.filter((l) => l.costValue !== null).map((l) => ({ warehouseId: warehouse._id, itemId: l.itemId })));
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      const current = await this.models.SalesInvoice.findOne({ tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'issued' }, null, { session }).lean();
      if (!current) throw versionConflict('invoice');
      await assertPeriodOpen(session, { tenantId: ctx.tenantId, legalEntityId: entity._id, docDate: current.docDate, models: this.models });
      const number = current.number ?? '';
      if (warehouse) {
        const outs = await this.models.StockMovement.find({ tenantId: ctx.tenantId, sourceType: 'sales_invoice', sourceId: doc._id, kind: 'issue', reversalOf: null }, { sourceLineId: 1 }, { session }).lean();
        const outByLine = new Map(outs.map((m) => [m.sourceLineId, m._id]));
        await this.core.ledger.post(
          this.postContext(ctx, session, entity, current, number),
          current.lines
            .filter((l) => l.costValue !== null)
            .map((l) => {
              const original = outByLine.get(l.lineId);
              if (!original) throw new Error(`Invoice ${number} line ${l.lineId} has no stock movement`);
              return { warehouseId: warehouse._id, itemId: l.itemId, label: l.item.sku, qty: l.qty.toString(), kind: 'issue', sourceLineId: l.lineId, effect: { type: 'restore', value: l.costValue?.toString() ?? '0.00', reversalOf: original } };
            }),
        );
      }
      await this.core.deps.journals.reverse(session, { tenantId: ctx.tenantId, sourceType: 'sales_invoice', sourceId: doc._id, docDate: current.docDate, narration: `Cancelled ${number}: ${input.reason}`, actorId: ctx.userId, now: this.core.now() });
      if (current.source && current.source.type !== 'quotation') {
        const model = current.source.type === 'dispatch' ? this.models.Dispatch : this.models.SalesOrder;
        const source = await model.findOne({ tenantId: ctx.tenantId, _id: current.source.id }, null, { session }).lean();
        if (!source) throw new Error('Source document missing');
        await this.updateSource(ctx, session, source, current.lines, entity, 'back', movedStock);
      }
      const updated = await this.models.SalesInvoice.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'issued' },
        { $set: { status: 'cancelled', outstanding: toDecimal('0.00'), cancelledBy: ctx.userId, cancelledAt: this.core.now(), cancelReason: input.reason }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('invoice');
      await this.core.audit(ctx, meta, doc, 'sales_invoice.cancelled', `Cancelled ${number} (number kept); journal reversed${warehouse ? `, goods returned to ${warehouse.code}` : ''}`, [{ field: 'status', from: 'issued', to: 'cancelled' }, { field: 'reason', to: input.reason }], session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  async discard(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_invoice', id);
    this.core.require(ctx, 'invoice.edit', doc.legalEntityId);
    if (!nextState(SALES_INVOICE_MACHINE, doc.status, 'discard')) throw invalidState('Only drafts can be discarded');
    const updated = await this.models.SalesInvoice.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: { status: 'discarded' }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('invoice');
    await this.core.audit(ctx, meta, doc, 'sales_invoice.discarded', `Discarded draft invoice for ${doc.partyName}`, [{ field: 'status', from: 'draft', to: 'discarded' }]);
    return this.core.toResponse(ctx, updated);
  }
}
