import { describe, expect, it } from 'vitest';
import {
  moneySchema,
  nonNegativeMoneySchema,
  objectIdSchema,
  quantitySchema,
  taxRateSchema,
  unitPriceSchema,
} from './primitives.js';

describe('decimal string schemas', () => {
  it.each(['0', '1', '1180.00', '-0.50', '999999999999999.99', '12.5'])('accepts money %s', (v) => {
    expect(moneySchema.safeParse(v).success).toBe(true);
  });

  it.each(['', '1.234', '01', '1e3', ' 1', '1,000.00', '-0', '-0.00', 'NaN', '1000000000000000'])(
    'rejects money %j',
    (v) => {
      expect(moneySchema.safeParse(v).success).toBe(false);
    },
  );

  it('rejects numbers for money (no floating point at the boundary)', () => {
    expect(moneySchema.safeParse(1180).success).toBe(false);
  });

  it('rejects negative non-negative money', () => {
    expect(nonNegativeMoneySchema.safeParse('-1.00').success).toBe(false);
  });

  it('allows 6 decimal unit prices and 3 decimal quantities', () => {
    expect(unitPriceSchema.safeParse('0.000125').success).toBe(true);
    expect(unitPriceSchema.safeParse('0.0000001').success).toBe(false);
    expect(quantitySchema.safeParse('12.345').success).toBe(true);
    expect(quantitySchema.safeParse('12.3456').success).toBe(false);
  });

  it('accepts typical tax rates', () => {
    for (const rate of ['0', '0.25', '3', '5', '18', '40']) {
      expect(taxRateSchema.safeParse(rate).success).toBe(true);
    }
  });
});

describe('objectIdSchema', () => {
  it('accepts a 24-hex id', () => {
    expect(objectIdSchema.safeParse('65f1a2b3c4d5e6f708192a3b').success).toBe(true);
  });

  it('rejects operator objects and malformed ids (NoSQL injection guard)', () => {
    expect(objectIdSchema.safeParse({ $gt: '' }).success).toBe(false);
    expect(objectIdSchema.safeParse('65F1A2B3C4D5E6F708192A3B').success).toBe(false);
    expect(objectIdSchema.safeParse('abc').success).toBe(false);
  });
});
