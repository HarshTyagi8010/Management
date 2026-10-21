import { z } from 'zod';

/**
 * Decimal values cross the API boundary as strings so that no binary floating
 * point is involved. Scales follow docs/architecture/financial-policy.md §1.
 * These schemas only validate shape; arithmetic lives in the domain package.
 */
function decimalString(maxIntegerDigits: number, maxScale: number, allowNegative: boolean) {
  const sign = allowNegative ? '-?' : '';
  const fraction = maxScale > 0 ? `(\\.\\d{1,${maxScale}})?` : '';
  const pattern = new RegExp(`^${sign}(0|[1-9]\\d{0,${maxIntegerDigits - 1}})${fraction}$`);
  return z
    .string()
    .regex(pattern, `Expected a decimal string with at most ${maxScale} decimal places`)
    .refine((value) => value !== '-0' && !/^-0(\.0+)?$/.test(value), 'Negative zero is not allowed');
}

/** Money in INR, 2 decimal places, may be negative (adjustments, round-off). */
export const moneySchema = decimalString(15, 2, true);
/** Non-negative money (document amounts, prices). */
export const nonNegativeMoneySchema = decimalString(15, 2, false);
/** Unit price / rate, up to 6 decimal places. */
export const unitPriceSchema = decimalString(15, 6, false);
/** Quantity, up to 3 decimal places (unit-specific limits are enforced in the domain). */
export const quantitySchema = decimalString(12, 3, true);
/** Tax rate percentage, up to 4 decimal places, 0–100 by shape (range checked in domain). */
export const taxRateSchema = decimalString(3, 4, false);

/** MongoDB ObjectId as a 24-character lowercase hex string. Validated before any query. */
export const objectIdSchema = z.string().regex(/^[0-9a-f]{24}$/, 'Expected a 24-character hex id');

/** Business date in YYYY-MM-DD (interpreted in IST by the domain). */
export const businessDateSchema = z.iso.date();

/** Idempotency key header value. */
export const idempotencyKeySchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9-]+$/, 'Expected letters, digits or hyphens');

export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(512).optional(),
});

export type Money = z.infer<typeof moneySchema>;
export type ObjectIdString = z.infer<typeof objectIdSchema>;
