import { dec, Dec } from './decimal.js';

/**
 * Sales document rules (workflows.md §1–4): allowed state transitions,
 * fulfilment and invoicing progress, due dates and ageing, and the amount in
 * words printed on invoices. Pure and deterministic.
 */

/** Command → the states it may start from and the state it leads to. Anything else is 409 INVALID_STATE. */
export interface Machine {
  readonly [action: string]: { readonly from: readonly string[]; readonly to: string };
}

export const QUOTATION_MACHINE = {
  send: { from: ['draft'], to: 'sent' },
  discard: { from: ['draft'], to: 'discarded' },
  accept: { from: ['sent'], to: 'accepted' },
  reject: { from: ['sent'], to: 'rejected' },
  /** The worker, once validUntil has passed. */
  expire: { from: ['sent'], to: 'expired' },
  /** The sent quotation is kept as it was; a new draft revision replaces it. */
  revise: { from: ['sent'], to: 'revised' },
  convert: { from: ['accepted'], to: 'converted' },
} as const satisfies Machine;

export const SALES_ORDER_MACHINE = {
  confirm: { from: ['draft'], to: 'confirmed' },
  discard: { from: ['draft'], to: 'discarded' },
  /** Nothing fulfilled yet: every reservation is released. */
  cancel: { from: ['confirmed'], to: 'cancelled' },
  /** Short-close: the unfulfilled remainder is released. */
  close: { from: ['partially_fulfilled'], to: 'closed' },
} as const satisfies Machine;

export const DISPATCH_MACHINE = {
  dispatch: { from: ['draft'], to: 'dispatched' },
  discard: { from: ['draft'], to: 'discarded' },
  /** Only while nothing on it has been invoiced (stock comes back). */
  cancel: { from: ['dispatched'], to: 'cancelled' },
} as const satisfies Machine;

export const SALES_INVOICE_MACHINE = {
  issue: { from: ['draft'], to: 'issued' },
  discard: { from: ['draft'], to: 'discarded' },
  cancel: { from: ['issued'], to: 'cancelled' },
} as const satisfies Machine;

/** The state `action` leads to from `state`, or null when the transition is not allowed. */
export function nextState<M extends Machine>(machine: M, state: string, action: keyof M & string): string | null {
  const t = machine[action];
  return t && (t.from as readonly string[]).includes(state) ? t.to : null;
}

const ZERO = new Dec(0);

/** Order status from fulfilled quantities (dispatched or invoiced, by the stock-out point). */
export function orderProgress(lines: ReadonlyArray<{ qty: string; fulfilled: string }>): 'confirmed' | 'partially_fulfilled' | 'fulfilled' {
  const anything = lines.some((l) => dec(l.fulfilled).greaterThan(ZERO));
  const everything = lines.every((l) => dec(l.fulfilled).greaterThanOrEqualTo(dec(l.qty)));
  return everything ? 'fulfilled' : anything ? 'partially_fulfilled' : 'confirmed';
}

/** Dispatch status from invoiced quantities. */
export function dispatchProgress(lines: ReadonlyArray<{ qty: string; invoiced: string }>): 'dispatched' | 'partially_invoiced' | 'invoiced' {
  const anything = lines.some((l) => dec(l.invoiced).greaterThan(ZERO));
  const everything = lines.every((l) => dec(l.invoiced).greaterThanOrEqualTo(dec(l.qty)));
  return everything ? 'invoiced' : anything ? 'partially_invoiced' : 'dispatched';
}

/** Quantity still open on a line: ordered (or dispatched) minus what was already taken, never below zero. */
export function remaining(qty: string, taken: string): string {
  const r = dec(qty).minus(dec(taken));
  return r.isNegative() ? '0' : r.toString();
}

// ------------------------------------------------------------- dates

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcDay(date: string): number {
  const m = DATE.exec(date);
  if (!m) throw new RangeError(`Not a business date: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError(`Not a business date: ${date}`);
  return ms / 86_400_000;
}

/** Adds whole days to a YYYY-MM-DD business date. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError('Days must be a whole number');
  return new Date((utcDay(date) + days) * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return utcDay(to) - utcDay(from);
}

export const AGEING_BUCKETS = ['not_due', 'd1_30', 'd31_60', 'd61_90', 'over_90'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Receivables ageing (FR-SAL-09): days past the due date on `asOf`, and the bucket they fall in. */
export function ageing(dueDate: string, asOf: string): { daysOverdue: number; bucket: AgeingBucket } {
  const days = daysBetween(dueDate, asOf);
  if (days <= 0) return { daysOverdue: 0, bucket: 'not_due' };
  return { daysOverdue: days, bucket: days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'over_90' };
}

// ----------------------------------------------------- amount in words

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = TENS[Math.floor(n / 10)] ?? '';
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Indian grouping: crore (10^7), lakh (10^5), thousand, hundred. Amounts of 100 crore and more repeat "Crore". */
function indianWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const crore = n / 10_000_000n;
  const rest = Number(n % 10_000_000n);
  const parts: string[] = [];
  if (crore > 0n) parts.push(`${indianWords(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  const thousand = Math.floor((rest % 100_000) / 1000);
  const below = rest % 1000;
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (below) parts.push(belowThousand(below));
  return parts.join(' ');
}

/** "1234.50" → "Rupees One Thousand Two Hundred Thirty-Four and Fifty Paise Only". */
export function amountInWords(amount: string): string {
  const d = dec(amount);
  if (d.isNegative() && !d.isZero()) throw new RangeError('Amount in words is for amounts of zero or more');
  const [rupees = '0', paiseText = ''] = d.toFixed(2).split('.');
  const paise = Number(paiseText);
  const words = `Rupees ${indianWords(BigInt(rupees))}`;
  return `${paise ? `${words} and ${belowHundred(paise)} Paise` : words} Only`;
}
