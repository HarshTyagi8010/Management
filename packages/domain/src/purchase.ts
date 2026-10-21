import { dec, Dec, money } from './decimal.js';
import type { Machine } from './sales.js';

/**
 * Purchase document rules (workflows.md §5): allowed state transitions,
 * receipt and billing progress, the supplier's round-off, and the cost a bill
 * line adds to stock or expenses. Pure and deterministic.
 */

export const PURCHASE_ORDER_MACHINE = {
  issue: { from: ['draft'], to: 'issued' },
  discard: { from: ['draft'], to: 'discarded' },
  /** Nothing received yet. */
  cancel: { from: ['issued'], to: 'cancelled' },
  /** Short-close: the rest will not be delivered. */
  close: { from: ['partially_received'], to: 'closed' },
} as const satisfies Machine;

export const GOODS_RECEIPT_MACHINE = {
  receive: { from: ['draft'], to: 'received' },
  discard: { from: ['draft'], to: 'discarded' },
  /** Only while nothing on it has been billed (the goods go back out). */
  cancel: { from: ['received'], to: 'cancelled' },
} as const satisfies Machine;

export const SUPPLIER_BILL_MACHINE = {
  post: { from: ['draft'], to: 'posted' },
  discard: { from: ['draft'], to: 'discarded' },
  cancel: { from: ['posted'], to: 'cancelled' },
} as const satisfies Machine;

const ZERO = new Dec(0);

/** Purchase order status from received quantities (by goods receipt or bill, by the stock-in point). */
export function purchaseOrderProgress(lines: ReadonlyArray<{ qty: string; received: string }>): 'issued' | 'partially_received' | 'received' {
  const anything = lines.some((l) => dec(l.received).greaterThan(ZERO));
  const everything = lines.every((l) => dec(l.received).greaterThanOrEqualTo(dec(l.qty)));
  return everything ? 'received' : anything ? 'partially_received' : 'issued';
}

/** Goods receipt status from billed quantities. */
export function goodsReceiptProgress(lines: ReadonlyArray<{ qty: string; billed: string }>): 'received' | 'partially_billed' | 'billed' {
  const anything = lines.some((l) => dec(l.billed).greaterThan(ZERO));
  const everything = lines.every((l) => dec(l.billed).greaterThanOrEqualTo(dec(l.qty)));
  return everything ? 'billed' : anything ? 'partially_billed' : 'received';
}

/** The largest round-off accepted between the computed bill and the total printed on the supplier's invoice. */
export const MAX_SUPPLIER_ROUND_OFF = '1.00';

/**
 * Round-off of a supplier bill: the invoice total as printed minus the
 * computed subtotal. Null when they differ by more than a rupee (the lines,
 * rates or quantities don't match the invoice).
 */
export function supplierRoundOff(subtotal: string, supplierTotal: string): string | null {
  const diff = dec(supplierTotal).minus(dec(subtotal));
  return diff.abs().greaterThan(dec(MAX_SUPPLIER_ROUND_OFF)) ? null : money(diff);
}

export interface TaxAmounts {
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
}

/** All GST on a line: charged by the supplier, or payable by the business under reverse charge. */
export function lineTax(a: TaxAmounts): string {
  return money(dec(a.cgst).plus(dec(a.sgst)).plus(dec(a.utgst)).plus(dec(a.igst)).plus(dec(a.cess)));
}

/**
 * What a bill line costs the business (financial-policy.md §6.4): the taxable
 * value, plus the tax when no input tax credit is claimed on it.
 */
export function billLineCost(a: TaxAmounts, itcEligible: boolean): string {
  return itcEligible ? money(dec(a.taxable)) : money(dec(a.taxable).plus(dec(lineTax(a))));
}

/**
 * The provisional value of received goods that a bill takes over: in
 * proportion to the quantity billed, and exactly what is left when the bill
 * takes the rest, so a fully billed receipt clears its value to the paisa.
 */
export function provisionalShare(line: { qty: string; value: string; billedQty: string; billedValue: string }, qty: string): string {
  const total = dec(line.qty);
  const after = dec(line.billedQty).plus(dec(qty));
  if (after.greaterThan(total)) throw new RangeError('Billing more than was received');
  const left = dec(line.value).minus(dec(line.billedValue));
  if (after.eq(total)) return money(left);
  const share = dec(money(dec(line.value).times(dec(qty)).dividedBy(total)));
  return money(share.greaterThan(left) ? left : share);
}
