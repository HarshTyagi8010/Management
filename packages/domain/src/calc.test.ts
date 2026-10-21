import { describe, expect, it } from 'vitest';
import { allocateLargestRemainder, calculate, CalcError, type CalcInput, type CalcLineInput, type CalcResult } from './calc.js';
import { dec } from './decimal.js';

/**
 * AC-CALC-1: fixtures with expected decimal outputs worked out by hand from
 * financial-policy.md §2–4. Rates here are arbitrary test numbers, not
 * statements of current law (GST-11).
 */
const L = (qty: string, unitPrice: string, o: Partial<CalcLineInput> = {}): CalcLineInput => ({ qty, unitPrice, discount: null, hsnSac: '7318', taxRate: '18', cessRate: null, reverseCharge: false, ...o });
const doc = (lines: CalcLineInput[], o: Partial<CalcInput> = {}): CalcInput => ({ supply: 'intra', utgst: false, noTax: false, documentDiscount: '0', roundOff: false, lines, ...o });

type Expect = { totals?: Partial<CalcResult['totals']>; lines?: Array<Partial<CalcResult['lines'][number]>>; hsnSummary?: Array<Partial<CalcResult['hsnSummary'][number]>> } | { error: string };

const FIXTURES: Array<[string, CalcInput, Expect]> = [
  ['F01 one line, intra 18%', doc([L('1', '100')]), { totals: { taxable: '100.00', cgst: '9.00', sgst: '9.00', igst: '0.00', grand: '118.00' } }],
  ['F02 one line, inter 18%', doc([L('1', '100')], { supply: 'inter' }), { totals: { igst: '18.00', cgst: '0.00', grand: '118.00' } }],
  ['F03 gross rounds per line (R1)', doc([L('3', '33.33')]), { lines: [{ gross: '99.99', cgst: '9.00', sgst: '9.00', total: '117.99' }] }],
  ['F04 six-decimal price', doc([L('3', '33.333333')]), { lines: [{ gross: '100.00', cgst: '9.00', total: '118.00' }] }],
  ['F05 fractional quantity', doc([L('0.333', '10.005', { taxRate: '5' })]), { lines: [{ gross: '3.33', cgst: '0.08', sgst: '0.08', total: '3.49' }] }],
  ['F06 percent discount', doc([L('1', '1000', { discount: { type: 'percent', value: '10' } })], { supply: 'inter' }), { lines: [{ discount: '100.00', net: '900.00', igst: '162.00', total: '1062.00' }] }],
  ['F07 percent discount rounds to paise', doc([L('7', '13.99', { discount: { type: 'percent', value: '12.5' } })]), { lines: [{ gross: '97.93', discount: '12.24', net: '85.69', cgst: '7.71', sgst: '7.71', total: '101.11' }] }],
  ['F08 amount discount', doc([L('2', '125', { taxRate: '5', discount: { type: 'amount', value: '50' } })], { supply: 'inter' }), { lines: [{ net: '200.00', igst: '10.00', total: '210.00' }] }],
  ['F09 discount above the line value is refused', doc([L('1', '10', { discount: { type: 'amount', value: '10.01' } })]), { error: 'lines.0.discount' }],
  [
    'F10 document discount split pro rata',
    doc([L('1', '100'), L('1', '200')], { documentDiscount: '30' }),
    { lines: [{ documentDiscount: '10.00', taxable: '90.00', cgst: '8.10' }, { documentDiscount: '20.00', taxable: '180.00', cgst: '16.20' }], totals: { taxable: '270.00', cgst: '24.30', sgst: '24.30', grand: '318.60' } },
  ],
  [
    'F11 largest remainder: a tie goes to the first line',
    doc([L('1', '100'), L('1', '100'), L('1', '100')], { supply: 'inter', documentDiscount: '10' }),
    { lines: [{ documentDiscount: '3.34', taxable: '96.66', igst: '17.40' }, { documentDiscount: '3.33', taxable: '96.67', igst: '17.40' }, { documentDiscount: '3.33' }], totals: { taxable: '290.00', igst: '52.20', grand: '342.20' } },
  ],
  [
    'F12 largest remainder: leftover paise to the largest remainders',
    doc([L('1', '10', { taxRate: null }), L('1', '20', { taxRate: null }), L('1', '70', { taxRate: null })], { documentDiscount: '0.07' }),
    { lines: [{ documentDiscount: '0.01' }, { documentDiscount: '0.01' }, { documentDiscount: '0.05' }], totals: { taxable: '99.93', grand: '99.93', discount: '0.07' } },
  ],
  [
    'F13 mixed rates',
    doc([L('1', '100', { taxRate: '5', hsnSac: '1001' }), L('1', '100', { hsnSac: '1002' }), L('1', '100', { taxRate: '40', hsnSac: '1003' })]),
    { totals: { cgst: '31.50', sgst: '31.50', grand: '363.00' }, hsnSummary: [{ hsnSac: '1001', rate: '5' }, { hsnSac: '1002', rate: '18' }, { hsnSac: '1003', rate: '40', cgst: '20.00' }] },
  ],
  ['F14 HSN summary sums lines (per-line rounding)', doc([L('1', '0.05'), L('1', '0.05'), L('1', '0.05')]), { hsnSummary: [{ hsnSac: '7318', taxable: '0.15', cgst: '0.00', sgst: '0.00' }], totals: { grand: '0.15' } }],
  ['F15 cess, inter', doc([L('1', '1000', { cessRate: '12' })], { supply: 'inter' }), { totals: { igst: '180.00', cess: '120.00', grand: '1300.00' } }],
  ['F16 cess, intra', doc([L('1', '999.99', { taxRate: '5', cessRate: '1' })]), { lines: [{ cgst: '25.00', sgst: '25.00', cess: '10.00', total: '1059.99' }] }],
  ['F17 UTGST instead of SGST', doc([L('1', '100')], { utgst: true }), { lines: [{ cgst: '9.00', sgst: '0.00', utgst: '9.00' }], totals: { utgst: '9.00', sgst: '0.00', grand: '118.00' } }],
  ['F18 exempt line', doc([L('1', '500', { taxRate: null })]), { lines: [{ taxable: '500.00', cgst: '0.00', total: '500.00' }], hsnSummary: [{ rate: null, taxable: '500.00' }] }],
  ['F19 bill of supply: no tax at all', doc([L('1', '100')], { noTax: true }), { totals: { cgst: '0.00', sgst: '0.00', grand: '100.00' }, hsnSummary: [{ rate: null }] }],
  [
    'F20 reverse charge: tax shown, not charged',
    doc([L('1', '1000', { reverseCharge: true })], { supply: 'inter' }),
    { lines: [{ igst: '180.00', taxCharged: '0.00', total: '1000.00', reverseCharge: true }], totals: { igst: '0.00', reverseChargeTax: '180.00', grand: '1000.00' } },
  ],
  [
    'F21 reverse charge mixed with normal lines',
    doc([L('1', '1000', { reverseCharge: true }), L('1', '100')]),
    { totals: { cgst: '9.00', sgst: '9.00', reverseChargeTax: '180.00', taxCharged: '18.00', subtotal: '1118.00' }, hsnSummary: [{ reverseCharge: true, cgst: '90.00' }, { reverseCharge: false, cgst: '9.00' }] },
  ],
  ['F22 round-off down', doc([L('1', '10.49', { taxRate: null })], { roundOff: true }), { totals: { subtotal: '10.49', roundOff: '-0.49', grand: '10.00' } }],
  ['F23 round-off up at exactly 50 paise', doc([L('1', '10.50', { taxRate: null })], { roundOff: true }), { totals: { roundOff: '0.50', grand: '11.00' } }],
  ['F24 round-off with tax', doc([L('1', '99')], { roundOff: true }), { totals: { subtotal: '116.82', roundOff: '0.18', grand: '117.00' } }],
  ['F25 round-off off', doc([L('1', '99')]), { totals: { roundOff: '0.00', grand: '116.82' } }],
  ['F26 round-off on a whole total', doc([L('1', '100')], { roundOff: true }), { totals: { roundOff: '0.00', grand: '118.00' } }],
  ['F27 free line blocked (C-05)', doc([L('1', '0')]), { error: 'lines.0.unitPrice' }],
  ['F28 free line allowed explicitly', doc([L('1', '0')], { allowFreeLines: true }), { totals: { taxable: '0.00', cgst: '0.00', grand: '0.00' } }],
  ['F29 zero quantity refused', doc([L('0', '10')]), { error: 'lines.0.qty' }],
  ['F30 negative price refused', doc([L('1', '-1')]), { error: 'lines.0.unitPrice' }],
  ['F31 document discount above the total refused', doc([L('1', '10')], { documentDiscount: '10.01' }), { error: 'documentDiscount' }],
  [
    'F32 line and document discounts together',
    doc([L('1', '200', { taxRate: '5', discount: { type: 'percent', value: '10' } }), L('1', '120', { taxRate: '5', discount: { type: 'amount', value: '20' } })], { supply: 'inter', documentDiscount: '28' }),
    { lines: [{ net: '180.00', documentDiscount: '18.00', taxable: '162.00', igst: '8.10' }, { net: '100.00', documentDiscount: '10.00', taxable: '90.00', igst: '4.50' }], totals: { discount: '68.00', taxable: '252.00', igst: '12.60', grand: '264.60' } },
  ],
  ['F33 maximum-precision quantity and price', doc([L('999999.999', '0.000125')], { supply: 'inter' }), { lines: [{ gross: '125.00', igst: '22.50', total: '147.50' }] }],
  ['F34 large values stay exact', doc([L('1000', '99999.99')]), { totals: { taxable: '99999990.00', cgst: '8999999.10', sgst: '8999999.10', grand: '117999988.20' } }],
  ['F35 fractional rate 0.25%', doc([L('1', '10000', { taxRate: '0.25' })], { supply: 'inter' }), { totals: { igst: '25.00', grand: '10025.00' } }],
  ['F36 rate 1.5%, halves round per component', doc([L('1', '1001', { taxRate: '1.5' })]), { lines: [{ cgst: '7.51', sgst: '7.51', total: '1016.02' }] }],
  ['F37 rate 3%, half-up at the fifth decimal', doc([L('1', '333.33', { taxRate: '3' })]), { lines: [{ cgst: '5.00', sgst: '5.00', total: '343.33' }] }],
  ['F38 half paisa rounds up (inter)', doc([L('1', '0.1', { taxRate: '5' })], { supply: 'inter' }), { lines: [{ igst: '0.01', total: '0.11' }] }],
  ['F39 quarter paisa per half rounds down (intra)', doc([L('1', '0.1', { taxRate: '5' })]), { lines: [{ cgst: '0.00', sgst: '0.00', total: '0.10' }] }],
  [
    'F40 document discount across taxable and exempt lines',
    doc([L('1', '100'), L('1', '100', { taxRate: null })], { supply: 'inter', documentDiscount: '50' }),
    { lines: [{ taxable: '75.00', igst: '13.50' }, { taxable: '75.00', igst: '0.00' }], totals: { grand: '163.50' } },
  ],
  ['F41 a fully discounted line', doc([L('1', '100', { discount: { type: 'percent', value: '100' } }), L('1', '50')]), { lines: [{ net: '0.00', total: '0.00' }, { cgst: '4.50' }], totals: { grand: '59.00' } }],
  [
    'F42 document discount skips a zero-value line',
    doc([L('1', '100', { discount: { type: 'percent', value: '100' } }), L('1', '50')], { documentDiscount: '5' }),
    { lines: [{ documentDiscount: '0.00' }, { documentDiscount: '5.00', taxable: '45.00', cgst: '4.05' }], totals: { grand: '53.10' } },
  ],
  ['F43 percent discount on a small value', doc([L('1', '0.99', { taxRate: null, discount: { type: 'percent', value: '33.33' } })]), { lines: [{ discount: '0.33', net: '0.66', total: '0.66' }] }],
  ['F44 many small lines: totals are sums of lines', doc(Array.from({ length: 10 }, () => L('1', '0.07'))), { totals: { taxable: '0.70', cgst: '0.10', sgst: '0.10', grand: '0.90' } }],
  ['F45 quantity × price then tax', doc([L('3', '1.11')], { supply: 'inter' }), { lines: [{ gross: '3.33', igst: '0.60', total: '3.93' }] }],
  ['F46 a rate above 100% is refused', doc([L('1', '1', { taxRate: '100.01' })]), { error: 'lines.0.taxRate' }],
  ['F47 cess with a zero GST rate', doc([L('1', '200', { taxRate: '0', cessRate: '5' })], { supply: 'inter' }), { totals: { igst: '0.00', cess: '10.00', grand: '210.00' } }],
];

describe('document calculation fixtures (AC-CALC-1)', () => {
  it('has at least 40 fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(FIXTURES)('%s', (_name, input, expected) => {
    if ('error' in expected) {
      expect(() => calculate(input)).toThrow(CalcError);
      try {
        calculate(input);
      } catch (err) {
        expect((err as CalcError).path).toBe(expected.error);
      }
      return;
    }
    const result = calculate(input);
    expect(result.calcVersion).toBe('calc-1');
    if (expected.totals) expect(result.totals).toMatchObject(expected.totals);
    expected.lines?.forEach((line, i) => expect(result.lines[i]).toMatchObject(line));
    expected.hsnSummary?.forEach((g, i) => expect(result.hsnSummary[i]).toMatchObject(g));
  });
});

describe('calculation invariants', () => {
  const ok = FIXTURES.filter(([, , e]) => !('error' in e)).map(([name, input]) => [name, input] as const);

  it.each(ok)('%s: totals are sums of lines and the summary agrees', (_name, input) => {
    const r = calculate(input);
    const sum = (pick: (l: CalcResult['lines'][number]) => string) => r.lines.reduce((a, l) => a.plus(dec(pick(l))), dec('0'));
    expect(sum((l) => l.taxable).eq(dec(r.totals.taxable))).toBe(true);
    expect(sum((l) => l.total).eq(dec(r.totals.subtotal))).toBe(true);
    expect(sum((l) => l.documentDiscount).eq(dec(input.documentDiscount))).toBe(true);
    expect(dec(r.totals.subtotal).plus(dec(r.totals.roundOff)).eq(dec(r.totals.grand))).toBe(true);
    expect(r.hsnSummary.reduce((a, g) => a.plus(dec(g.taxable)), dec('0')).eq(dec(r.totals.taxable))).toBe(true);
    // Deterministic: the same input gives the same output.
    expect(calculate(input)).toEqual(r);
  });

  it('allocates exactly, whatever the weights', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 200; round += 1) {
      const weights = Array.from({ length: rand(8) + 1 }, () => `${rand(100000)}.${String(rand(100)).padStart(2, '0')}`);
      if (weights.every((w) => dec(w).isZero())) continue;
      const total = `${rand(1000)}.${String(rand(100)).padStart(2, '0')}`;
      const shares = allocateLargestRemainder(total, weights);
      expect(shares.reduce((a, s) => a.plus(dec(s)), dec('0')).eq(dec(total))).toBe(true);
      expect(shares.every((s) => !s.startsWith('-'))).toBe(true);
    }
  });
});
