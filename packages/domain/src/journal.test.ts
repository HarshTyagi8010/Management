import { describe, expect, it } from 'vitest';
import { balanceJournal, consolidate, JournalError, pair } from './journal.js';

describe('journals (financial-policy §8)', () => {
  it('accepts a balanced journal and totals it', () => {
    const j = balanceJournal([
      { account: '1300', debit: '100.50', credit: '0' },
      { account: '3100', debit: '0', credit: '100.5' },
      { account: '9999', debit: '0', credit: '0' },
    ]);
    expect(j).toEqual({ lines: [{ account: '1300', debit: '100.50', credit: '0.00' }, { account: '3100', debit: '0.00', credit: '100.50' }], totalDebit: '100.50', totalCredit: '100.50' });
  });

  it.each([
    ['unbalanced', [{ account: 'a', debit: '1', credit: '0' }, { account: 'b', debit: '0', credit: '0.99' }]],
    ['negative', [{ account: 'a', debit: '-1', credit: '0' }, { account: 'b', debit: '0', credit: '-1' }]],
    ['both sides on one line', [{ account: 'a', debit: '1', credit: '1' }]],
    ['sub-paisa amounts', [{ account: 'a', debit: '0.001', credit: '0' }, { account: 'b', debit: '0', credit: '0.001' }]],
  ])('refuses a journal that is %s', (_name, lines) => {
    expect(() => balanceJournal(lines)).toThrow(JournalError);
  });

  it('pairs a signed amount and nets accounts to one side', () => {
    expect(pair('25.00', 'inv', 'adj')).toEqual([
      { account: 'inv', debit: '25.00', credit: '0.00' },
      { account: 'adj', debit: '0.00', credit: '25.00' },
    ]);
    expect(pair('-25', 'inv', 'adj')[0]).toEqual({ account: 'adj', debit: '25.00', credit: '0.00' });
    expect(pair('0', 'inv', 'adj')).toEqual([]);
    expect(consolidate([...pair('30', 'inv', 'adj'), ...pair('-10', 'inv', 'adj')])).toEqual([
      { account: 'inv', debit: '20.00', credit: '0.00' },
      { account: 'adj', debit: '0.00', credit: '20.00' },
    ]);
  });
});
