import { Decimal } from 'decimal.js';

/**
 * The one decimal configuration for business arithmetic (financial-policy.md §1):
 * 34 significant digits (as Decimal128) and half-up rounding. Values enter and
 * leave as decimal strings; no JavaScript number is ever involved.
 */
export const Dec = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });
export type Dec = InstanceType<typeof Dec>;

export const MONEY_DP = 2;
export const COST_DP = 6;
export const QTY_DP = 3;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Parses a decimal string. Anything else (numbers, exponents, NaN) is a programming error. */
export function dec(value: string): Dec {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new RangeError(`Not a decimal string: ${JSON.stringify(value)}`);
  return new Dec(value);
}

/** Rounds half-up to `dp` places and formats with exactly `dp` places; never returns negative zero. */
export function fixed(value: Dec, dp: number): string {
  const rounded = value.toDecimalPlaces(dp, Dec.ROUND_HALF_UP);
  return (rounded.isZero() ? new Dec(0) : rounded).toFixed(dp);
}

export const money = (value: Dec) => fixed(value, MONEY_DP);
export const cost = (value: Dec) => fixed(value, COST_DP);

/** Decimal places written in a decimal string ("12.50" → 2). */
export const scaleOf = (value: string) => value.split('.')[1]?.length ?? 0;

/** Formats a quantity with the unit's number of decimals; refuses to drop significant digits. */
export function formatQty(value: string, decimals: number): string {
  const d = dec(value);
  const out = fixed(d, decimals);
  if (!dec(out).eq(d)) throw new RangeError(`Quantity ${value} has more than ${decimals} decimal places`);
  return out;
}

/** Whether a quantity string fits the unit's decimals (trailing zeros beyond it are allowed: "5.000" for NOS). */
export function fitsDecimals(value: string, decimals: number): boolean {
  const d = dec(value);
  return d.toDecimalPlaces(decimals).eq(d);
}

export const sum = (values: readonly string[]): Dec => values.reduce((acc, v) => acc.plus(dec(v)), new Dec(0));
export const eq = (a: string, b: string) => dec(a).eq(dec(b));
export const isZero = (a: string) => dec(a).isZero();
export const isNegative = (a: string) => dec(a).isNegative() && !dec(a).isZero();
export const negate = (a: string) => {
  const d = dec(a).negated();
  return (d.isZero() ? new Dec(0) : d).toString();
};
