import { cost, dec, Dec, money } from './decimal.js';

/**
 * Moving weighted-average valuation per (legal entity, item): financial-policy.md §6.
 * Quantity is entity-wide (all warehouses plus goods in transit between them);
 * value is held at 2 decimals and the average unit cost at 6.
 *
 * Invariant kept by every function here: quantity 0 ⇒ value 0, so no paise are
 * left behind when stock runs out.
 */
export interface ValuationState {
  qty: string;
  value: string;
  /** Last known average; null until the first receipt. */
  avgCost: string | null;
}

export const EMPTY_VALUATION: ValuationState = { qty: '0', value: '0.00', avgCost: null };

const plain = (d: Dec) => (d.isZero() ? '0' : d.toString());
const ZERO_DEC = new Dec(0);

function positive(qty: string, what: string): Dec {
  const q = dec(qty);
  if (!q.isPositive() || q.isZero()) throw new RangeError(`${what} quantity must be more than zero`);
  return q;
}

export interface ReceiptResult {
  state: ValuationState;
  /** Value of the received goods: qty × unit cost, rounded to paise. */
  value: string;
  /**
   * Extra value change beyond the receipt itself, non-zero only when stock was
   * negative: the units issued while negative went out at the old average, and
   * the average is now corrected to the receipt cost (financial-policy.md §6).
   */
  revaluation: string;
}

/** Stock in at a known unit cost (opening stock, positive adjustments, purchases). */
export function receive(state: ValuationState, qty: string, unitCost: string): ReceiptResult {
  const q = positive(qty, 'Received');
  const c = dec(unitCost);
  if (c.isNegative() && !c.isZero()) throw new RangeError('Unit cost must not be negative');
  const oldQty = dec(state.qty);
  const oldValue = dec(state.value);
  const receiptValue = dec(money(q.times(c)));
  const newQty = oldQty.plus(q);

  if (!oldQty.isNegative() || oldQty.isZero()) {
    const newValue = oldValue.plus(receiptValue);
    return { state: { qty: plain(newQty), value: money(newValue), avgCost: cost(newValue.dividedBy(newQty)) }, value: money(receiptValue), revaluation: '0.00' };
  }

  // Negative before the receipt: restate the remaining stock at the receipt cost
  // (or, if still negative, at the last average) and report the difference.
  const targetAvg = newQty.isPositive() && !newQty.isZero() ? c : dec(state.avgCost ?? cost(c));
  const targetValue = dec(money(newQty.times(targetAvg)));
  const revaluation = targetValue.minus(oldValue.plus(receiptValue));
  return { state: { qty: plain(newQty), value: money(targetValue), avgCost: cost(targetAvg) }, value: money(receiptValue), revaluation: money(revaluation) };
}

export interface IssueCost {
  /** Unit cost recorded on the movement (6 dp), kept for later reversals. */
  unitCost: string;
  /** Value of the issued goods, positive, 2 dp. */
  value: string;
}

/**
 * Cost of taking `qty` out at the current average. Issuing everything that is
 * left takes the whole remaining value, so rounding never leaves paise behind.
 * Without any average yet (negative stock before a first receipt) the cost is 0,
 * corrected by the revaluation on the next receipt.
 */
export function issueCost(state: ValuationState, qty: string): IssueCost {
  const q = positive(qty, 'Issued');
  const oldQty = dec(state.qty);
  const oldValue = dec(state.value);
  const avg = dec(state.avgCost ?? '0');
  if (q.eq(oldQty)) return { unitCost: cost(oldValue.dividedBy(q)), value: money(oldValue) };
  let value = dec(money(q.times(avg)));
  // The rounded average can overshoot what is left when almost everything is issued.
  if (q.lessThan(oldQty) && value.greaterThan(oldValue) && !oldValue.isNegative()) value = oldValue;
  return { unitCost: cost(avg), value: money(value) };
}

/** Stock out of the entity (adjustments, sales): the average stays, quantity and value go down. */
export function issue(state: ValuationState, qty: string): IssueCost & { state: ValuationState } {
  const result = issueCost(state, qty);
  const newQty = dec(state.qty).minus(dec(qty));
  return { ...result, state: { qty: plain(newQty), value: money(dec(state.value).minus(dec(result.value))), avgCost: state.avgCost } };
}

/**
 * Stock back at exactly the value it left with (a cancelled sale or dispatch,
 * financial-policy.md §6): the reversal undoes the issue to the paisa, even when
 * that issue was capped at what was left. Negative stock is restated as in `receive`.
 */
export function restore(state: ValuationState, qty: string, value: string): ReceiptResult {
  const q = positive(qty, 'Returned');
  const v = dec(value);
  if (v.isNegative() && !v.isZero()) throw new RangeError('Value must not be negative');
  const oldQty = dec(state.qty);
  const oldValue = dec(state.value);
  const newQty = oldQty.plus(q);
  if (!oldQty.isNegative() || oldQty.isZero()) {
    const newValue = oldValue.plus(v);
    return { state: { qty: plain(newQty), value: money(newValue), avgCost: cost(newValue.dividedBy(newQty)) }, value: money(v), revaluation: '0.00' };
  }
  const unit = v.dividedBy(q);
  const targetAvg = newQty.isPositive() && !newQty.isZero() ? unit : dec(state.avgCost ?? cost(unit));
  const targetValue = dec(money(newQty.times(targetAvg)));
  return { state: { qty: plain(newQty), value: money(targetValue), avgCost: cost(targetAvg) }, value: money(v), revaluation: money(targetValue.minus(oldValue.plus(v))) };
}

/**
 * Stock out of the entity at a known value (a cancelled goods receipt or
 * supplier bill takes back what it brought in: financial-policy.md §6.4). The
 * average is restated from what is left. When the remaining value would break
 * the invariants (value left with no stock, or negative value with stock on
 * hand), the difference is reported as a revaluation and the value set to 0.
 */
export function issueAt(state: ValuationState, qty: string, value: string): ReceiptResult {
  const q = positive(qty, 'Returned');
  const v = dec(value);
  if (v.isNegative() && !v.isZero()) throw new RangeError('Value must not be negative');
  const newQty = dec(state.qty).minus(q);
  const left = dec(state.value).minus(v);
  if (newQty.isNegative() && !newQty.isZero()) {
    // Negative stock (allowed by the entity override): keep the last average, as an issue does.
    return { state: { qty: plain(newQty), value: money(left), avgCost: state.avgCost }, value: money(v), revaluation: '0.00' };
  }
  if (newQty.isZero() || left.isNegative()) {
    return { state: { qty: plain(newQty), value: '0.00', avgCost: newQty.isZero() ? state.avgCost : cost(ZERO_DEC) }, value: money(v), revaluation: money(left.negated()) };
  }
  return { state: { qty: plain(newQty), value: money(left), avgCost: cost(left.dividedBy(newQty)) }, value: money(v), revaluation: '0.00' };
}

export interface CostAdjustment {
  state: ValuationState;
  /** Part of the difference that changed the value of stock on hand (signed, 2 dp). */
  inventory: string;
  /** The rest: goods already issued, so it belongs to cost of goods sold (signed, 2 dp). */
  cogs: string;
}

/**
 * A supplier bill whose cost differs from the provisional cost of the goods
 * receipt (financial-policy.md §6.4): the difference applies to stock on hand
 * in proportion to how much of `basisQty` (the quantity billed) is still on
 * hand; the share for goods already issued goes to cost of goods sold. The
 * quantity does not change; the value never goes below zero.
 */
export function adjustCost(state: ValuationState, delta: string, basisQty: string): CostAdjustment {
  const d = dec(delta);
  const basis = positive(basisQty, 'Billed');
  const qty = dec(state.qty);
  const value = dec(state.value);
  if (d.isZero() || !qty.isPositive() || qty.isZero()) return { state, inventory: '0.00', cogs: money(d) };
  let share = qty.greaterThanOrEqualTo(basis) ? d : dec(money(d.times(qty).dividedBy(basis)));
  if (value.plus(share).isNegative()) share = value.negated();
  const newValue = value.plus(share);
  return { state: { qty: state.qty, value: money(newValue), avgCost: cost(newValue.dividedBy(qty)) }, inventory: money(share), cogs: money(d.minus(share)) };
}

/** Inventory value of a quantity at an average cost (financial-policy.md §9, "Inventory value"). */
export function valueAt(qty: string, avgCost: string | null): string {
  return money(dec(qty).times(dec(avgCost ?? '0')));
}
