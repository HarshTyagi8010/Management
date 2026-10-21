import { describe, expect, it } from 'vitest';
import { formatBusinessDate, formatINR, formatINRCompact, formatQuantity } from './format';

describe('formatINR', () => {
  it.each([
    ['0', '₹0.00'],
    ['5', '₹5.00'],
    ['999', '₹999.00'],
    ['1000', '₹1,000.00'],
    ['100000', '₹1,00,000.00'],
    ['1234567.5', '₹12,34,567.50'],
    ['123456789012345.99', '₹12,34,56,78,90,12,345.99'],
    ['-1180.00', '−₹1,180.00'],
    ['-0.00', '₹0.00'],
    ['007.10', '₹7.10'],
  ])('%s → %s', (input, expected) => {
    expect(formatINR(input)).toBe(expected);
  });

  it('can omit the symbol', () => {
    expect(formatINR('1500', { symbol: false })).toBe('1,500.00');
  });

  it('rejects non-decimal input and excess precision instead of rounding', () => {
    expect(() => formatINR('1e5')).toThrow(RangeError);
    expect(() => formatINR('12.345')).toThrow(RangeError);
    expect(() => formatINR('')).toThrow(RangeError);
  });

  it('does not lose precision beyond 2^53', () => {
    expect(formatINR('9007199254740993.01')).toBe('₹9,00,71,99,25,47,40,993.01');
  });
});

describe('formatINRCompact', () => {
  it.each([
    ['84500', '₹84,500'],
    ['250000', '₹2.5 L'],
    ['1299999.99', '₹12.99 L'],
    ['12000000', '₹1.2 Cr'],
    ['1234567890', '₹123.45 Cr'],
    ['-560000', '−₹5.6 L'],
  ])('%s → %s', (input, expected) => {
    expect(formatINRCompact(input)).toBe(expected);
  });
});

describe('formatQuantity / formatBusinessDate', () => {
  it('keeps quantity precision', () => {
    expect(formatQuantity('1250.500')).toBe('1,250.500');
    expect(formatQuantity('12')).toBe('12');
  });

  it('formats business dates as DD-MM-YYYY', () => {
    expect(formatBusinessDate('2026-04-01')).toBe('01-04-2026');
    expect(() => formatBusinessDate('01/04/2026')).toThrow(RangeError);
  });
});
