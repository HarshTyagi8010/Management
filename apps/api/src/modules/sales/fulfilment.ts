import type { Types } from 'mongoose';
import { Dec, dec, dispatchProgress, orderProgress, remaining } from '@bizmgmt/domain';
import type { SalesDocDoc, SalesLineDoc } from '../../models.js';
import { toDecimal } from '../../platform/values.js';
import { invalid, qtyOf, rule } from './core.js';

/**
 * How documents made from other documents relate to them (FR-SAL-03/04/05,
 * FR-INV-10):
 * - A dispatch made from an order takes its order's stock lines, up to what is
 *   still unfulfilled, from the order's warehouse.
 * - With the dispatch as the stock-out point, goods leave only with a dispatch:
 *   an invoice's stock lines must come from a dispatch (up to what is not yet
 *   invoiced); an invoice made from an order carries only its non-stock lines.
 * - With the invoice as the stock-out point there are no dispatches; an invoice
 *   made from an order takes any of its lines, up to what is unfulfilled.
 * Lines not linked to a source line are allowed for non-stock items (freight,
 * services) and, at the invoice stock-out point, for stock items too.
 */
export type SourceKind = 'dispatch_from_order' | 'invoice_from_order' | 'invoice_from_dispatch';

export const OPEN_ORDER = ['confirmed', 'partially_fulfilled'];
const isStock = (l: Pick<SalesLineDoc, 'item'>) => l.item.type === 'stock';

/** Open quantity on a source line for the kind of document drawing on it. */
export function openOn(kind: SourceKind, line: SalesLineDoc): string {
  return kind === 'invoice_from_dispatch' ? remaining(line.qty.toString(), qtyOf(line.invoicedQty)) : remaining(line.qty.toString(), qtyOf(line.fulfilledQty));
}

/** Checks a document's lines against its source and the stock-out point; throws on the first problem. */
export function checkLines(kind: SourceKind | null, lines: SalesLineDoc[], source: SalesDocDoc | null, stockOutPoint: 'dispatch' | 'invoice', docType: 'dispatch' | 'sales_invoice' | 'sales_order' | 'quotation') {
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    const path = `lines.${i}`;
    if (docType === 'dispatch' && !isStock(l)) throw invalid(`${path}.itemId`, `${l.item.sku} is not a stock item: only stock items are dispatched`);
    if (!l.sourceLineId) {
      if (kind === 'dispatch_from_order') throw invalid(`${path}.sourceLineId`, 'Every line of a dispatch made from an order must come from the order');
      if (docType === 'sales_invoice' && isStock(l) && stockOutPoint === 'dispatch') throw invalid(`${path}.itemId`, `Goods leave with a dispatch in your workflow: dispatch ${l.item.sku} first, then invoice the dispatch`);
      return;
    }
    if (!kind || !source) throw invalid(`${path}.sourceLineId`, 'This line is not linked to another document');
    if (seen.has(l.sourceLineId)) throw invalid(`${path}.sourceLineId`, 'Each line of the source document only once');
    seen.add(l.sourceLineId);
    const from = source.lines.find((s) => s.lineId === l.sourceLineId);
    if (!from) throw invalid(`${path}.sourceLineId`, `This line is not on ${source.number ?? 'the source document'}`);
    if (!from.itemId.equals(l.itemId)) throw invalid(`${path}.itemId`, `The line must be for ${from.item.sku}, as on ${source.number ?? 'the source document'}`);
    if (kind === 'invoice_from_order' && stockOutPoint === 'dispatch' && isStock(from)) throw invalid(`${path}.sourceLineId`, `Goods on the order leave with a dispatch in your workflow: invoice the dispatch for ${from.item.sku}`);
    if (kind === 'dispatch_from_order' && !isStock(from)) throw invalid(`${path}.sourceLineId`, `${from.item.sku} is not a stock item`);
    const open = openOn(kind, from);
    if (dec(l.qty.toString()).greaterThan(dec(open))) {
      throw rule(`${from.item.sku}: only ${open} left to ${kind === 'dispatch_from_order' ? 'dispatch' : 'invoice'} on ${source.number ?? 'the source document'}`, `${path}.qty`);
    }
  });
}

export function sourceKind(docType: 'dispatch' | 'sales_invoice', source: SalesDocDoc['source']): SourceKind | null {
  if (!source) return null;
  if (docType === 'dispatch') return 'dispatch_from_order';
  return source.type === 'dispatch' ? 'invoice_from_dispatch' : 'invoice_from_order';
}

/** The source must still be open to draw on. */
export function checkSourceOpen(kind: SourceKind, source: SalesDocDoc) {
  if (kind === 'invoice_from_dispatch') {
    if (source.status !== 'dispatched' && source.status !== 'partially_invoiced') throw rule(`Dispatch ${source.number ?? ''} is ${source.status.replace('_', ' ')}: nothing more can be invoiced from it`.replace('  ', ' '));
  } else if (!OPEN_ORDER.includes(source.status)) {
    throw rule(`Sales order ${source.number ?? ''} is ${source.status.replace('_', ' ')}: nothing more can be ${kind === 'dispatch_from_order' ? 'dispatched' : 'invoiced'} from it`.replace('  ', ' '));
  }
}

export interface LineDelta {
  fulfilled?: string;
  invoiced?: string;
  /** Change in reserved quantity (negative = used up or released). */
  reserved?: string;
}

const plus = (v: Types.Decimal128 | null | undefined, d: string | undefined) => (d ? toDecimal(dec(qtyOf(v)).plus(dec(d)).toString()) : (v ?? toDecimal('0')));

/** New lines and status of an order after fulfilment changes. Closed and cancelled orders keep their status. */
export function applyToOrder(order: SalesDocDoc, deltas: Map<string, LineDelta>): { lines: SalesLineDoc[]; status: string } {
  const lines = order.lines.map((l) => {
    const d = deltas.get(l.lineId);
    if (!d) return l;
    const next = { ...l, fulfilledQty: plus(l.fulfilledQty, d.fulfilled), invoicedQty: plus(l.invoicedQty, d.invoiced), reservedQty: plus(l.reservedQty, d.reserved) };
    for (const k of ['fulfilledQty', 'invoicedQty', 'reservedQty'] as const) {
      if (dec(next[k].toString()).isNegative()) throw new Error(`Order ${order.number} line ${l.lineId}: ${k} would go below zero`);
    }
    if (dec(next.fulfilledQty.toString()).greaterThan(dec(next.qty.toString()))) throw new Error(`Order ${order.number} line ${l.lineId} would be over-fulfilled`);
    return next;
  });
  const status = ['confirmed', 'partially_fulfilled', 'fulfilled'].includes(order.status) ? orderProgress(lines.map((l) => ({ qty: l.qty.toString(), fulfilled: qtyOf(l.fulfilledQty) }))) : order.status;
  return { lines, status };
}

/** New lines and status of a dispatch after invoicing changes. */
export function applyToDispatch(dispatch: SalesDocDoc, invoiced: Map<string, string>): { lines: SalesLineDoc[]; status: string } {
  const lines = dispatch.lines.map((l) => {
    const d = invoiced.get(l.lineId);
    if (!d) return l;
    const next = { ...l, invoicedQty: plus(l.invoicedQty, d) };
    const n = dec(next.invoicedQty.toString());
    if (n.isNegative() || n.greaterThan(dec(next.qty.toString()))) throw new Error(`Dispatch ${dispatch.number} line ${l.lineId}: invoiced quantity out of range`);
    return next;
  });
  return { lines, status: dispatchProgress(lines.map((l) => ({ qty: l.qty.toString(), invoiced: qtyOf(l.invoicedQty) }))) };
}

/** A share of an amount in proportion to part/whole, floored to the paisa (document discount on a partial conversion). */
export function proRata(amount: string, part: string, whole: string): string {
  const w = dec(whole);
  if (w.isZero() || dec(amount).isZero()) return '0';
  return dec(amount).times(dec(part)).dividedBy(w).toDecimalPlaces(2, Dec.ROUND_DOWN).toFixed(2);
}

/**
 * Lines (and document discount) carried from a source document to a new draft:
 * `take` gives the quantity to carry for each source line ('0' skips it).
 * Amount discounts and the document discount follow the share of value carried.
 */
export function carryLines(source: SalesDocDoc, take: (line: SalesLineDoc) => string): { lines: Array<{ itemId: string; qty: string; unitPrice: string; discount: { type: 'percent' | 'amount'; value: string } | null; sourceLineId: string }>; documentDiscount: string } {
  let carried = dec('0');
  let whole = dec('0');
  const lines = source.lines.flatMap((l) => {
    const gross = dec(l.qty.toString()).times(dec(l.unitPrice.toString()));
    whole = whole.plus(gross);
    const qty = take(l);
    if (dec(qty).isZero()) return [];
    carried = carried.plus(dec(qty).times(dec(l.unitPrice.toString())));
    const partial = !dec(qty).eq(dec(l.qty.toString()));
    const discount = l.discount ? { type: l.discount.type, value: l.discount.type === 'amount' && partial ? proRata(l.discount.value.toString(), qty, l.qty.toString()) : l.discount.value.toString() } : null;
    return [{ itemId: l.itemId.toHexString(), qty, unitPrice: l.unitPrice.toString(), discount, sourceLineId: l.lineId }];
  });
  return { lines, documentDiscount: proRata(source.documentDiscount.toString(), carried.toString(), whole.toString()) };
}
