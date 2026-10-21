import { dec, Dec, money } from './decimal.js';

/**
 * Document calculation: financial-policy.md §2–4 (calcVersion "calc-1").
 * Pure and deterministic: the same input always gives the same output. Rounding
 * happens only at the documented stages:
 *   R1 gross per line → paise; line discount → paise
 *   R2 document discount allocated across lines by largest remainder (Σ shares = discount)
 *   R3 each tax component per line → paise
 *   R4 optional round-off of the grand total to the rupee (half-up), shown separately
 * Totals are sums of line values, never re-rounded.
 */
export const CALC_VERSION = 'calc-1';

export type LineDiscount = { type: 'percent'; value: string } | { type: 'amount'; value: string } | null;

export interface CalcLineInput {
  qty: string;
  unitPrice: string;
  discount: LineDiscount;
  hsnSac: string;
  /** GST rate in percent; null for exempt, nil-rated and non-GST lines (no tax). */
  taxRate: string | null;
  /** Ad valorem cess in percent, if any (GST-12). */
  cessRate: string | null;
  /** Tax is payable by the recipient (GST-13): shown, but not added to the line total. */
  reverseCharge: boolean;
}

export interface CalcInput {
  /** Intra-state: CGST + SGST/UTGST. Inter-state: IGST (GST-09). */
  supply: 'intra' | 'inter';
  /** Intra-state supply in a Union Territory without legislature: UTGST instead of SGST. */
  utgst: boolean;
  /** No tax at all, e.g. a composition taxpayer's bill of supply. */
  noTax: boolean;
  /** Discount on the whole document before tax, in rupees. */
  documentDiscount: string;
  /** Round the grand total to the nearest rupee (financial-policy §3). */
  roundOff: boolean;
  /** Zero-price lines are blocked unless allowed (free supplies: legal review C-05). */
  allowFreeLines?: boolean;
  lines: CalcLineInput[];
}

export interface CalcLine {
  gross: string;
  discount: string;
  net: string;
  documentDiscount: string;
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  /** Tax added to this line's total (0 for reverse-charge lines). */
  taxCharged: string;
  total: string;
  reverseCharge: boolean;
}

export interface TaxTotals {
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
}

export interface CalcResult {
  calcVersion: string;
  lines: CalcLine[];
  totals: TaxTotals & {
    gross: string;
    /** Line discounts plus the document discount. */
    discount: string;
    /** Tax charged on the document (excludes reverse-charge tax). */
    taxCharged: string;
    /** Tax the recipient pays under reverse charge (shown, not collected). */
    reverseChargeTax: string;
    /** Before round-off. */
    subtotal: string;
    roundOff: string;
    grand: string;
  };
  /** Grouped by HSN/SAC, rate and reverse charge; sums of line values (consistent with per-line rounding). */
  hsnSummary: Array<TaxTotals & { hsnSac: string; rate: string | null; reverseCharge: boolean }>;
}

export class CalcError extends Error {
  override readonly name = 'CalcError';
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

const ZERO = new Dec(0);
const HUNDRED = new Dec(100);

function nonNegative(value: string, path: string, what: string): Dec {
  const d = dec(value);
  if (d.isNegative() && !d.isZero()) throw new CalcError(path, `${what} can’t be negative`);
  return d;
}

function rate(value: string | null, path: string): Dec | null {
  if (value === null) return null;
  const d = nonNegative(value, path, 'A rate');
  if (d.greaterThan(HUNDRED)) throw new CalcError(path, 'A rate is at most 100 percent');
  return d;
}

const round2 = (d: Dec) => d.toDecimalPlaces(2, Dec.ROUND_HALF_UP);

/**
 * Stage R2: splits `total` (rupees) across `weights` pro rata, in whole paise.
 * Each share is floored; the leftover paise go one each to the largest
 * remainders, ties to the earlier line. Σ shares = total exactly.
 */
export function allocateLargestRemainder(total: string, weights: readonly string[]): string[] {
  const paise = dec(total).times(HUNDRED);
  if (!paise.isInteger()) throw new CalcError('documentDiscount', 'Amounts have at most 2 decimal places');
  const w = weights.map((x) => dec(x));
  const sum = w.reduce((a, b) => a.plus(b), ZERO);
  if (paise.isZero()) return w.map(() => '0.00');
  if (sum.isZero()) throw new CalcError('documentDiscount', 'There is nothing to discount');
  const raw = w.map((x) => paise.times(x).dividedBy(sum));
  const floors = raw.map((r) => r.floor());
  let leftover = paise.minus(floors.reduce((a, b) => a.plus(b), ZERO)).toNumber();
  const order = raw.map((r, i) => ({ i, rem: r.minus(r.floor()) })).sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  const shares = [...floors];
  for (const { i } of order) {
    if (leftover <= 0) break;
    shares[i] = (shares[i] ?? ZERO).plus(1);
    leftover -= 1;
  }
  return shares.map((s) => money(s.dividedBy(HUNDRED)));
}

export function calculate(input: CalcInput): CalcResult {
  if (input.lines.length === 0) throw new CalcError('lines', 'Add at least one line');

  // R1: gross and line discounts.
  const stage1 = input.lines.map((line, i) => {
    const path = `lines.${i}`;
    const qty = dec(line.qty);
    if (!qty.isPositive() || qty.isZero()) throw new CalcError(`${path}.qty`, 'Quantity must be more than zero');
    const price = nonNegative(line.unitPrice, `${path}.unitPrice`, 'The price');
    if (price.isZero() && !input.allowFreeLines) throw new CalcError(`${path}.unitPrice`, 'Free supplies need a decision on their tax treatment (legal review C-05) and are blocked');
    const gross = round2(qty.times(price));
    let discount = ZERO;
    if (line.discount?.type === 'percent') {
      const pct = rate(line.discount.value, `${path}.discount`) ?? ZERO;
      discount = round2(gross.times(pct).dividedBy(HUNDRED));
    } else if (line.discount?.type === 'amount') {
      discount = nonNegative(line.discount.value, `${path}.discount`, 'A discount');
      if (!discount.times(HUNDRED).isInteger()) throw new CalcError(`${path}.discount`, 'Amounts have at most 2 decimal places');
      if (discount.greaterThan(gross)) throw new CalcError(`${path}.discount`, 'The discount is more than the line value');
    }
    return { line, path, gross, discount, net: gross.minus(discount) };
  });

  // R2: document discount.
  const docDiscount = nonNegative(input.documentDiscount, 'documentDiscount', 'The discount');
  const netSum = stage1.reduce((a, l) => a.plus(l.net), ZERO);
  if (docDiscount.greaterThan(netSum)) throw new CalcError('documentDiscount', 'The discount is more than the document value');
  const shares = allocateLargestRemainder(money(docDiscount), stage1.map((l) => l.net.toString()));

  // R3: taxes per line.
  const lines: CalcLine[] = stage1.map((l, i) => {
    const share = dec(shares[i] ?? '0');
    const taxable = l.net.minus(share);
    const gst = input.noTax ? null : rate(l.line.taxRate, `${l.path}.taxRate`);
    const cessRate = input.noTax ? null : rate(l.line.cessRate, `${l.path}.cessRate`);
    let cgst = ZERO;
    let sgst = ZERO;
    let igst = ZERO;
    if (gst) {
      if (input.supply === 'intra') {
        cgst = round2(taxable.times(gst).dividedBy(200));
        sgst = cgst;
      } else {
        igst = round2(taxable.times(gst).dividedBy(HUNDRED));
      }
    }
    const cess = cessRate ? round2(taxable.times(cessRate).dividedBy(HUNDRED)) : ZERO;
    const tax = cgst.plus(sgst).plus(igst).plus(cess);
    const charged = l.line.reverseCharge ? ZERO : tax;
    return {
      gross: money(l.gross),
      discount: money(l.discount),
      net: money(l.net),
      documentDiscount: money(share),
      taxable: money(taxable),
      cgst: money(cgst),
      sgst: input.utgst ? '0.00' : money(sgst),
      utgst: input.utgst ? money(sgst) : '0.00',
      igst: money(igst),
      cess: money(cess),
      taxCharged: money(charged),
      total: money(taxable.plus(charged)),
      reverseCharge: l.line.reverseCharge && !tax.isZero(),
    };
  });

  const total = (pick: (l: CalcLine) => string, where: (l: CalcLine) => boolean = () => true) => money(lines.filter(where).reduce((a, l) => a.plus(dec(pick(l))), ZERO));
  const charged = (l: CalcLine) => !l.reverseCharge;
  const subtotal = dec(total((l) => l.total));
  // R4: half-up to the rupee, so the difference is between −0.49 and +0.50.
  const grand = input.roundOff ? subtotal.toDecimalPlaces(0, Dec.ROUND_HALF_UP) : subtotal;

  const groups = new Map<string, CalcResult['hsnSummary'][number]>();
  lines.forEach((l, i) => {
    const r = input.noTax ? null : (input.lines[i]?.taxRate ?? null);
    const key = `${input.lines[i]?.hsnSac}|${r ?? '-'}|${l.reverseCharge}`;
    const g = groups.get(key) ?? { hsnSac: input.lines[i]?.hsnSac ?? '', rate: r === null ? null : dec(r).toString(), reverseCharge: l.reverseCharge, taxable: '0.00', cgst: '0.00', sgst: '0.00', utgst: '0.00', igst: '0.00', cess: '0.00' };
    for (const k of ['taxable', 'cgst', 'sgst', 'utgst', 'igst', 'cess'] as const) g[k] = money(dec(g[k]).plus(dec(l[k])));
    groups.set(key, g);
  });

  return {
    calcVersion: CALC_VERSION,
    lines,
    totals: {
      gross: total((l) => l.gross),
      discount: money(dec(total((l) => l.discount)).plus(docDiscount)),
      taxable: total((l) => l.taxable),
      cgst: total((l) => l.cgst, charged),
      sgst: total((l) => l.sgst, charged),
      utgst: total((l) => l.utgst, charged),
      igst: total((l) => l.igst, charged),
      cess: total((l) => l.cess, charged),
      taxCharged: total((l) => l.taxCharged),
      reverseChargeTax: money(lines.filter((l) => l.reverseCharge).reduce((a, l) => a.plus(dec(l.cgst)).plus(dec(l.sgst)).plus(dec(l.utgst)).plus(dec(l.igst)).plus(dec(l.cess)), ZERO)),
      subtotal: money(subtotal),
      roundOff: money(grand.minus(subtotal)),
      grand: money(grand),
    },
    hsnSummary: [...groups.values()],
  };
}
