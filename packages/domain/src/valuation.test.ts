import { describe, expect, it } from 'vitest';
import { dec, fitsDecimals, fixed, formatQty, negate, sum } from './decimal.js';
import { EMPTY_VALUATION, issue, issueCost, receive, valueAt, type ValuationState } from './valuation.js';

describe('decimal helpers', () => {
  it('rounds half-up and never prints negative zero', () => {
    expect(fixed(dec('2.345'), 2)).toBe('2.35');
    expect(fixed(dec('-2.345'), 2)).toBe('-2.35');
    expect(fixed(dec('-0.004'), 2)).toBe('0.00');
    expect(negate('0')).toBe('0');
    expect(negate('-1.50')).toBe('1.5');
  });

  it('keeps exact digits where binary floating point would not', () => {
    expect(sum(['0.1', '0.2']).toString()).toBe('0.3');
    expect(fixed(dec('1.005'), 2)).toBe('1.01');
  });

  it('checks and formats quantities against unit decimals', () => {
    expect(fitsDecimals('5', 0)).toBe(true);
    expect(fitsDecimals('5.000', 0)).toBe(true);
    expect(fitsDecimals('5.5', 0)).toBe(false);
    expect(fitsDecimals('1.235', 2)).toBe(false);
    expect(formatQty('3.000', 0)).toBe('3');
    expect(formatQty('3.5', 3)).toBe('3.500');
    expect(() => formatQty('3.5', 0)).toThrow(RangeError);
  });

  it('refuses anything that is not a decimal string', () => {
    expect(() => dec('1e3')).toThrow(RangeError);
    expect(() => dec('NaN')).toThrow(RangeError);
    expect(() => dec(1 as unknown as string)).toThrow(RangeError);
  });
});

describe('moving weighted average (financial-policy.md §6)', () => {
  it('averages receipts and issues at the average', () => {
    let s: ValuationState = EMPTY_VALUATION;
    s = receive(s, '10', '100').state;
    expect(s).toEqual({ qty: '10', value: '1000.00', avgCost: '100.000000' });
    s = receive(s, '5', '130').state;
    // (1000 + 650) / 15 = 110
    expect(s).toEqual({ qty: '15', value: '1650.00', avgCost: '110.000000' });
    const out = issue(s, '4');
    expect(out).toMatchObject({ unitCost: '110.000000', value: '440.00' });
    expect(out.state).toEqual({ qty: '11', value: '1210.00', avgCost: '110.000000' });
  });

  it('rounds the average to 6 places and value to paise', () => {
    const s = receive(receive(EMPTY_VALUATION, '3', '10').state, '1', '0.01').state;
    expect(s).toEqual({ qty: '4', value: '30.01', avgCost: '7.502500' });
    const t = receive(receive(EMPTY_VALUATION, '1', '5').state, '2', '2.5').state;
    expect(t).toEqual({ qty: '3', value: '10.00', avgCost: '3.333333' });
    // 0.333 kg at ₹10.005: value rounds half-up to ₹3.33.
    expect(receive(EMPTY_VALUATION, '0.333', '10.005').value).toBe('3.33');
  });

  it('takes the whole remaining value when issuing everything, leaving no paise behind', () => {
    // 3 units worth ₹10.00: average 3.333333.
    let s = receive(EMPTY_VALUATION, '3', '3.333333').state;
    const first = issue(s, '1');
    expect(first.value).toBe('3.33');
    s = first.state;
    const second = issue(s, '1');
    expect(second.value).toBe('3.33');
    const last = issue(second.state, '1');
    expect(last.value).toBe('3.34');
    expect(last.state).toEqual({ qty: '0', value: '0.00', avgCost: '3.333333' });
  });

  it('values transfers without changing the entity valuation', () => {
    const s = receive(EMPTY_VALUATION, '8', '12.5').state;
    expect(issueCost(s, '2')).toEqual({ unitCost: '12.500000', value: '25.00' });
    expect(issueCost(s, '8')).toEqual({ unitCost: '12.500000', value: '100.00' });
  });

  it('caps an issue at the remaining value when the rounded average overshoots', () => {
    const s: ValuationState = { qty: '1000000', value: '1000000.00', avgCost: '1.000001' };
    expect(issueCost(s, '999999.999').value).toBe('1000000.00');
  });

  it('issues negative stock at the last average and corrects it on the next receipt', () => {
    let s = receive(EMPTY_VALUATION, '2', '50').state;
    const out = issue(s, '5');
    expect(out.value).toBe('250.00');
    s = out.state;
    expect(s).toEqual({ qty: '-3', value: '-150.00', avgCost: '50.000000' });
    // 10 arrive at ₹60: 7 remain, restated at ₹60 = ₹420; the 3 issued short cost ₹30 more.
    const r = receive(s, '10', '60');
    expect(r.value).toBe('600.00');
    expect(r.revaluation).toBe('-30.00');
    expect(r.state).toEqual({ qty: '7', value: '420.00', avgCost: '60.000000' });
    // Check: value before + receipt + revaluation = value after.
    expect(dec('-150').plus(dec(r.value)).plus(dec(r.revaluation)).eq(dec(r.state.value))).toBe(true);
  });

  it('issues at zero cost when no average exists yet', () => {
    const out = issue(EMPTY_VALUATION, '2');
    expect(out).toMatchObject({ unitCost: '0.000000', value: '0.00', state: { qty: '-2', value: '0.00', avgCost: null } });
    const r = receive(out.state, '2', '40');
    expect(r).toMatchObject({ revaluation: '-80.00', state: { qty: '0', value: '0.00', avgCost: '40.000000' } });
  });

  it('rejects zero or negative quantities and negative costs', () => {
    expect(() => receive(EMPTY_VALUATION, '0', '1')).toThrow(RangeError);
    expect(() => receive(EMPTY_VALUATION, '1', '-1')).toThrow(RangeError);
    expect(() => issue(EMPTY_VALUATION, '-1')).toThrow(RangeError);
  });

  it('values on-hand stock at the average', () => {
    expect(valueAt('2.5', '10.333333')).toBe('25.83');
    expect(valueAt('4', null)).toBe('0.00');
  });

  it('stays exact over a long random sequence: value is always the sum of its parts', () => {
    let s: ValuationState = EMPTY_VALUATION;
    let ledger = dec('0');
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 500; i += 1) {
      const qty = String(rand(20) + 1);
      if (rand(3) === 0 && dec(s.qty).greaterThanOrEqualTo(dec(qty))) {
        const out = issue(s, qty);
        ledger = ledger.minus(dec(out.value));
        s = out.state;
      } else {
        const r = receive(s, qty, `${rand(500)}.${String(rand(1000)).padStart(3, '0')}`);
        ledger = ledger.plus(dec(r.value)).plus(dec(r.revaluation));
        s = r.state;
      }
      expect(ledger.eq(dec(s.value))).toBe(true);
      if (dec(s.qty).isZero()) expect(s.value).toBe('0.00');
    }
  });
});
