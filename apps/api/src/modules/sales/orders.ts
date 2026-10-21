import { salesOrderInputSchema, SALES_STATUS_LABELS, type AuditChange, type SalesDocument, type SalesDocStatus } from '@bizmgmt/contracts';
import { dec, nextState, remaining, SALES_ORDER_MACHINE } from '@bizmgmt/domain';
import type { SalesDocDoc } from '../../models.js';
import { withTransaction } from '../../platform/transactions.js';
import { toDecimal, todayIST, versionConflict } from '../../platform/values.js';
import type { RequestMeta } from '../identity/identity.js';
import type { TenantContext } from '../tenancy/tenancy.js';
import { invalid, invalidState, qtyOf, rule, type DraftInput, type SalesCore } from './core.js';
import { carryLines, OPEN_ORDER } from './fulfilment.js';

type OrderInput = ReturnType<typeof salesOrderInputSchema.parse>;
type Patch = { version: number } & Partial<Record<keyof OrderInput, unknown>>;

const label = (status: string) => SALES_STATUS_LABELS[status as SalesDocStatus]?.toLowerCase() ?? status;
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Sales orders (FR-SAL-03, workflows.md §2). Confirming numbers the order and
 * reserves its stock lines in the order's warehouse (FR-INV-05): reserved
 * quantities reduce what is available, never what is on hand. Dispatches (or
 * invoices, by the stock-out point) fulfil the order and use up the
 * reservation; cancelling or short-closing it releases what is left.
 */
export class SalesOrderService {
  constructor(private readonly core: SalesCore) {}

  private get models() {
    return this.core.deps.models;
  }

  async create(ctx: TenantContext, input: OrderInput, meta: RequestMeta): Promise<SalesDocument> {
    const entity = await this.core.findEntity(ctx, input.legalEntityId, ['salesorder.edit']);
    this.core.require(ctx, 'salesorder.edit', entity._id);
    this.core.checkDate(entity, input.docDate, false);
    if (input.lines.some((l) => l.sourceLineId)) throw invalid('lines', 'Order lines are not linked to other documents');
    const c = await this.core.compute(ctx, 'sales_order', input);
    const doc = this.core.newDraft(ctx, 'sales_order', c);
    await this.models.SalesOrder.create([doc]);
    await this.core.audit(ctx, meta, doc, 'sales_order.created', `Drafted sales order for ${doc.partyName}`);
    return this.core.toResponse(ctx, doc);
  }

  async get(ctx: TenantContext, id: string) {
    return this.core.toResponse(ctx, await this.core.findDoc(ctx, 'sales_order', id));
  }

  async update(ctx: TenantContext, id: string, patch: Patch, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_order', id);
    this.core.require(ctx, 'salesorder.edit', doc.legalEntityId);
    if (doc.status !== 'draft') throw invalidState('Only drafts can be edited');
    const { version, ...fields } = patch;
    const merged = salesOrderInputSchema.parse({ ...this.core.inputOf(doc), ...defined(fields) });
    if (merged.lines.some((l) => l.sourceLineId)) throw invalid('lines', 'Order lines are not linked to other documents');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['salesorder.edit']);
    this.core.checkDate(entity, merged.docDate, false);
    const c = await this.core.compute(ctx, 'sales_order', merged);
    const saved = await this.core.saveDraft(ctx, doc, version, c.fields);
    await this.core.audit(ctx, meta, doc, 'sales_order.updated', `Edited draft sales order for ${saved.partyName}`, Object.keys(defined(fields)).map((field) => ({ field })));
    return this.core.toResponse(ctx, saved);
  }

  /** Numbers the order, freezes it and reserves its stock lines (one transaction). */
  async confirm(ctx: TenantContext, id: string, input: { version: number; overrideCreditLimit: boolean }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_order', id);
    this.core.require(ctx, 'salesorder.confirm', doc.legalEntityId);
    if (!nextState(SALES_ORDER_MACHINE, doc.status, 'confirm')) throw invalidState(`Only a draft can be confirmed; this order is ${label(doc.status)}`);
    if (doc.version !== input.version) throw versionConflict('sales order');
    const entity = await this.core.findEntity(ctx, doc.legalEntityId, ['salesorder.confirm']);
    this.core.checkDate(entity, doc.docDate, false);
    const c = await this.core.compute(ctx, 'sales_order', this.core.inputOf(doc));
    const stock = c.fields.lines.filter((l) => l.item.type === 'stock');
    if (stock.length && !c.warehouse) throw rule('Choose the warehouse the goods will leave from: confirming reserves them there', 'warehouseId');
    if (c.warehouse) this.core.requireInWarehouse(ctx, 'salesorder.confirm', c.warehouse);
    const credit = await this.core.checkCredit(ctx, c.party, c.fields.totals.grand.toString(), input.overrideCreditLimit, entity._id);
    const series = await this.core.prepareSeries(ctx, doc, 'sales_order', c.registration);
    if (c.warehouse) await this.core.ledger.ensureRows(ctx.tenantId, entity._id, stock.map((l) => ({ warehouseId: c.warehouse!._id, itemId: l.itemId })));
    const lines = c.fields.lines.map((l) => ({ ...l, reservedQty: l.item.type === 'stock' ? l.qty : toDecimal('0') }));
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      const numbered = await this.core.takeNumber(session, ctx, series, doc.docDate);
      for (const l of lines) {
        if (l.item.type !== 'stock' || !c.warehouse) continue;
        await this.core.ledger.reserve({ session, tenantId: ctx.tenantId, allowNegative: entity.workflow.allowNegativeStock }, { warehouseId: c.warehouse._id, itemId: l.itemId, label: l.item.sku, qty: l.qty.toString(), sourceLineId: l.lineId });
      }
      const updated = await this.models.SalesOrder.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: 'draft' },
        { $set: { ...c.fields, lines, ...numbered, warnings: [], status: 'confirmed', issuedBy: ctx.userId, issuedAt: this.core.now() }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('sales order');
      const changes: AuditChange[] = [{ field: 'status', from: 'draft', to: 'confirmed' }, ...(credit ? [credit] : [])];
      if (updated.placeOfSupplyOverridden) changes.push({ field: 'placeOfSupply', to: updated.placeOfSupply });
      await this.core.audit(ctx, meta, doc, 'sales_order.confirmed', `Confirmed sales order ${numbered.number} for ${updated.partyName}${stock.length ? `; reserved ${stock.length} item${stock.length === 1 ? '' : 's'}` : ''}`, changes, session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  /** Cancel (nothing fulfilled) or short-close (partly fulfilled): what is still reserved is released. */
  async end(ctx: TenantContext, id: string, action: 'cancel' | 'close', input: { version: number; reason: string }, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_order', id);
    this.core.require(ctx, 'salesorder.cancel', doc.legalEntityId);
    const to = nextState(SALES_ORDER_MACHINE, doc.status, action);
    if (!to) {
      throw invalidState(
        action === 'cancel'
          ? doc.status === 'partially_fulfilled'
            ? 'Part of this order has been fulfilled: close it instead to release the rest'
            : `Only a confirmed order can be cancelled; this one is ${label(doc.status)}`
          : `Only a partly fulfilled order can be closed; this one is ${label(doc.status)}`,
      );
    }
    if (doc.version !== input.version) throw versionConflict('sales order');
    const saved = await withTransaction(this.core.deps.connection, async (session) => {
      const current = await this.models.SalesOrder.findOne({ tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: doc.status }, null, { session }).lean();
      if (!current) throw versionConflict('sales order');
      for (const l of current.lines) {
        const held = qtyOf(l.reservedQty);
        if (dec(held).isZero() || !current.warehouseId) continue;
        await this.core.ledger.release({ session, tenantId: ctx.tenantId }, current.warehouseId, l.itemId, held);
      }
      const updated = await this.models.SalesOrder.findOneAndUpdate(
        { tenantId: ctx.tenantId, _id: doc._id, version: input.version, status: doc.status },
        { $set: { status: to, lines: current.lines.map((l) => ({ ...l, reservedQty: toDecimal('0') })), cancelledBy: ctx.userId, cancelledAt: this.core.now(), cancelReason: input.reason }, $inc: { version: 1 } },
        { session, returnDocument: 'after' },
      ).lean();
      if (!updated) throw versionConflict('sales order');
      await this.core.audit(ctx, meta, doc, action === 'cancel' ? 'sales_order.cancelled' : 'sales_order.closed', `${action === 'cancel' ? 'Cancelled' : 'Short-closed'} sales order ${doc.number}; reservations released`, [{ field: 'status', from: doc.status, to }, { field: 'reason', to: input.reason }], session);
      return updated;
    });
    return this.core.toResponse(ctx, saved);
  }

  async discard(ctx: TenantContext, id: string, version: number, meta: RequestMeta): Promise<SalesDocument> {
    const doc = await this.core.findDoc(ctx, 'sales_order', id);
    this.core.require(ctx, 'salesorder.edit', doc.legalEntityId);
    if (!nextState(SALES_ORDER_MACHINE, doc.status, 'discard')) throw invalidState('Only drafts can be discarded');
    const updated = await this.models.SalesOrder.findOneAndUpdate({ tenantId: ctx.tenantId, _id: doc._id, version, status: 'draft' }, { $set: { status: 'discarded' }, $inc: { version: 1 } }, { returnDocument: 'after' }).lean();
    if (!updated) throw versionConflict('sales order');
    await this.core.audit(ctx, meta, doc, 'sales_order.discarded', `Discarded draft sales order for ${doc.partyName}`, [{ field: 'status', from: 'draft', to: 'discarded' }]);
    return this.core.toResponse(ctx, updated);
  }

  /** The common header of a document made from the order (same customer, GSTIN, addresses and terms). */
  private header(order: SalesDocDoc): Omit<DraftInput, 'lines' | 'documentDiscount'> {
    const { lines: _l, documentDiscount: _d, expectedDate: _e, ...rest } = this.core.inputOf(order);
    return { ...rest, docDate: todayIST(this.core.now()), seriesId: null };
  }

  /** A draft dispatch for what is still to be dispatched (stock-out point: dispatch). */
  async makeDispatch(ctx: TenantContext, id: string, meta: RequestMeta): Promise<SalesDocument> {
    const order = await this.core.findDoc(ctx, 'sales_order', id);
    if (!OPEN_ORDER.includes(order.status)) throw invalidState(`Sales order ${order.number ?? ''} is ${label(order.status)}: there is nothing to dispatch`.replace('  ', ' '));
    const entity = await this.core.findEntity(ctx, order.legalEntityId, ['dispatch.post']);
    if (entity.workflow.stockOutPoint !== 'dispatch') throw rule('Goods leave with the invoice in your workflow: create an invoice from the order instead');
    if (!order.warehouseId) throw rule('This order has no warehouse');
    const warehouse = await this.core.findWarehouse(ctx, order.warehouseId, entity._id, order.gstRegistrationId);
    this.core.requireInWarehouse(ctx, 'dispatch.post', warehouse);
    const { lines, documentDiscount } = carryLines(order, (l) => (l.item.type === 'stock' ? remaining(l.qty.toString(), qtyOf(l.fulfilledQty)) : '0'));
    if (!lines.length) throw rule('Everything on this order has been dispatched');
    const input: DraftInput = { ...this.header(order), warehouseId: order.warehouseId.toHexString(), transport: { vehicleNumber: '', transporterName: '', ewayBillNumber: '' }, lines, documentDiscount };
    const c = await this.core.compute(ctx, 'dispatch', input);
    const draft = this.core.newDraft(ctx, 'dispatch', c, { source: { type: 'sales_order', id: order._id } });
    await this.models.Dispatch.create([draft]);
    await this.core.audit(ctx, meta, draft, 'dispatch.created', `Drafted dispatch from sales order ${order.number} for ${draft.partyName}`);
    return this.core.toResponse(ctx, draft);
  }

  /**
   * A draft invoice for what is still to be invoiced from the order itself:
   * every line when the invoice is the stock-out point, otherwise the
   * non-stock lines only (goods are invoiced from their dispatches).
   */
  async makeInvoice(ctx: TenantContext, id: string, meta: RequestMeta): Promise<SalesDocument> {
    const order = await this.core.findDoc(ctx, 'sales_order', id);
    this.core.require(ctx, 'invoice.edit', order.legalEntityId);
    if (!OPEN_ORDER.includes(order.status)) throw invalidState(`Sales order ${order.number ?? ''} is ${label(order.status)}: there is nothing to invoice from it`.replace('  ', ' '));
    const entity = await this.core.findEntity(ctx, order.legalEntityId, ['invoice.edit']);
    const atInvoice = entity.workflow.stockOutPoint === 'invoice';
    const { lines, documentDiscount } = carryLines(order, (l) => (atInvoice || l.item.type !== 'stock' ? remaining(l.qty.toString(), qtyOf(l.fulfilledQty)) : '0'));
    if (!lines.length) throw rule(atInvoice ? 'Everything on this order has been invoiced' : 'Nothing on this order is invoiced directly: dispatch the goods, then invoice the dispatch');
    const input: DraftInput = { ...this.header(order), warehouseId: order.warehouseId?.toHexString() ?? null, dueDate: null, lines, documentDiscount };
    const c = await this.core.compute(ctx, 'sales_invoice', input);
    const draft = this.core.newDraft(ctx, 'sales_invoice', c, { source: { type: 'sales_order', id: order._id } });
    await this.models.SalesInvoice.create([draft]);
    await this.core.audit(ctx, meta, draft, 'sales_invoice.created', `Drafted invoice from sales order ${order.number} for ${draft.partyName}`);
    return this.core.toResponse(ctx, draft);
  }
}
