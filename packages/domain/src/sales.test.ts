import { describe, expect, it } from 'vitest';
import {
  addDays,
  ageing,
  amountInWords,
  daysBetween,
  dispatchProgress,
  DISPATCH_MACHINE,
  nextState,
  orderProgress,
  QUOTATION_MACHINE,
  remaining,
  SALES_INVOICE_MACHINE,
  SALES_ORDER_MACHINE,
  type Machine,
} from './sales.js';
import { EMPTY_VALUATION, issue, receive, restore } from './valuation.js';

/** Every state named anywhere in a machine. */
const statesOf = (m: Machine) => [...new Set(Object.values(m).flatMap((t) => [...t.from, t.to]))];

describe('state machines (workflows.md §1–4)', () => {
  const machines: Array<[string, Machine]> = [
    ['quotation', QUOTATION_MACHINE],
    ['sales order', SALES_ORDER_MACHINE],
    ['dispatch', DISPATCH_MACHINE],
    ['sales invoice', SALES_INVOICE_MACHINE],
  ];

  it.each(machines)('%s: every listed transition is allowed, every other start state refused', (_name, machine) => {
    for (const [action, t] of Object.entries(machine)) {
      for (const state of statesOf(machine)) {
        expect(nextState(machine, state, action)).toBe(t.from.includes(state) ? t.to : null);
      }
    }
  });

  it('follows the documented paths', () => {
    expect(nextState(QUOTATION_MACHINE, 'draft', 'send')).toBe('sent');
    expect(nextState(QUOTATION_MACHINE, 'sent', 'revise')).toBe('revised');
    expect(nextState(QUOTATION_MACHINE, 'accepted', 'convert')).toBe('converted');
    expect(nextState(QUOTATION_MACHINE, 'sent', 'convert')).toBeNull();
    expect(nextState(SALES_ORDER_MACHINE, 'partially_fulfilled', 'cancel')).toBeNull();
    expect(nextState(SALES_ORDER_MACHINE, 'partially_fulfilled', 'close')).toBe('closed');
    expect(nextState(DISPATCH_MACHINE, 'invoiced', 'cancel')).toBeNull();
    // No edits after issue: an issued invoice can only be cancelled.
    expect(nextState(SALES_INVOICE_MACHINE, 'issued', 'issue')).toBeNull();
    expect(nextState(SALES_INVOICE_MACHINE, 'cancelled', 'cancel')).toBeNull();
    expect(nextState(SALES_INVOICE_MACHINE, 'issued', 'cancel')).toBe('cancelled');
  });
});

describe('fulfilment and invoicing progress', () => {
  it('derives the order status from fulfilled quantities', () => {
    expect(orderProgress([{ qty: '5', fulfilled: '0' }, { qty: '2', fulfilled: '0' }])).toBe('confirmed');
    expect(orderProgress([{ qty: '5', fulfilled: '5' }, { qty: '2', fulfilled: '0' }])).toBe('partially_fulfilled');
    expect(orderProgress([{ qty: '5', fulfilled: '0.001' }])).toBe('partially_fulfilled');
    expect(orderProgress([{ qty: '5', fulfilled: '5.000' }, { qty: '2.5', fulfilled: '2.5' }])).toBe('fulfilled');
  });

  it('derives the dispatch status from invoiced quantities', () => {
    expect(dispatchProgress([{ qty: '3', invoiced: '0' }])).toBe('dispatched');
    expect(dispatchProgress([{ qty: '3', invoiced: '1' }])).toBe('partially_invoiced');
    expect(dispatchProgress([{ qty: '3', invoiced: '3' }, { qty: '1', invoiced: '1' }])).toBe('invoiced');
  });

  it('never reports a negative remainder', () => {
    expect(remaining('5', '2')).toBe('3');
    expect(remaining('5', '5')).toBe('0');
    expect(remaining('5', '6')).toBe('0');
    expect(remaining('2.5', '0.75')).toBe('1.75');
  });
});

describe('due dates and ageing (FR-SAL-09)', () => {
  it('adds days across months, leap years and financial years', () => {
    expect(addDays('2026-10-20', 30)).toBe('2026-11-19');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-03-31', 1)).toBe('2027-04-01');
    expect(addDays('2026-10-20', 0)).toBe('2026-10-20');
    expect(daysBetween('2026-10-20', '2026-10-01')).toBe(-19);
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-10-20', 1.5)).toThrow(RangeError);
  });

  it.each([
    ['2026-10-20', '2026-10-19', 0, 'not_due'],
    ['2026-10-20', '2026-10-20', 0, 'not_due'],
    ['2026-10-20', '2026-10-21', 1, 'd1_30'],
    ['2026-10-20', '2026-11-19', 30, 'd1_30'],
    ['2026-10-20', '2026-11-20', 31, 'd31_60'],
    ['2026-10-20', '2026-12-19', 60, 'd31_60'],
    ['2026-10-20', '2027-01-18', 90, 'd61_90'],
    ['2026-10-20', '2027-01-19', 91, 'over_90'],
  ])('due %s, as of %s → %i days, %s', (due, asOf, days, bucket) => {
    expect(ageing(due, asOf)).toEqual({ daysOverdue: days, bucket });
  });
});

describe('amount in words (Indian numbering)', () => {
  it.each([
    ['0', 'Rupees Zero Only'],
    ['0.50', 'Rupees Zero and Fifty Paise Only'],
    ['1', 'Rupees One Only'],
    ['21.05', 'Rupees Twenty-One and Five Paise Only'],
    ['100', 'Rupees One Hundred Only'],
    ['1234.50', 'Rupees One Thousand Two Hundred Thirty-Four and Fifty Paise Only'],
    ['100000', 'Rupees One Lakh Only'],
    ['1234567.89', 'Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven and Eighty-Nine Paise Only'],
    ['10000000', 'Rupees One Crore Only'],
    ['987654321', 'Rupees Ninety-Eight Crore Seventy-Six Lakh Fifty-Four Thousand Three Hundred Twenty-One Only'],
    ['12345678901', 'Rupees One Thousand Two Hundred Thirty-Four Crore Fifty-Six Lakh Seventy-Eight Thousand Nine Hundred One Only'],
    ['999999999999999.99', 'Rupees Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine Crore Ninety-Nine Lakh Ninety-Nine Thousand Nine Hundred Ninety-Nine and Ninety-Nine Paise Only'],
  ])('%s', (amount, words) => {
    expect(amountInWords(amount)).toBe(words);
  });

  it('refuses negative amounts', () => {
    expect(() => amountInWords('-1')).toThrow(RangeError);
  });
});

describe('restoring issued stock (financial-policy §6)', () => {
  it('puts back exactly the value that left, even when the issue was capped', () => {
    // 3 units worth 10.00: the average is 3.333333, and issuing 2 then the last 1 leaves no paise behind.
    const start = receive(EMPTY_VALUATION, '3', '3.333333').state;
    expect(start).toEqual({ qty: '3', value: '10.00', avgCost: '3.333333' });
    const out = issue(start, '2');
    expect(out.value).toBe('6.67');
    const back = restore(out.state, '2', out.value);
    expect(back.state).toEqual({ qty: '3', value: '10.00', avgCost: '3.333333' });
    expect(back.revaluation).toBe('0.00');
  });

  it('restates negative stock like a receipt', () => {
    const negative = { qty: '-2', value: '-8.00', avgCost: '4.000000' };
    const back = restore(negative, '5', '25.00');
    expect(back.state).toEqual({ qty: '3', value: '15.00', avgCost: '5.000000' });
    expect(back.revaluation).toBe('-2.00');
  });

  it('refuses zero quantities and negative values', () => {
    expect(() => restore(EMPTY_VALUATION, '0', '1.00')).toThrow(RangeError);
    expect(() => restore(EMPTY_VALUATION, '1', '-1.00')).toThrow(RangeError);
  });
});
