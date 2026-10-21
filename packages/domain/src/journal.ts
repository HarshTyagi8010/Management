import { dec, Dec, money } from './decimal.js';

/**
 * Double-entry journals (financial-policy.md §8, ADR-011). Each line is a debit
 * or a credit (never both, never negative); Σ debit = Σ credit.
 */
export interface JournalLineInput {
  account: string;
  debit: string;
  credit: string;
}

export interface BalancedJournal<L extends JournalLineInput> {
  lines: L[];
  totalDebit: string;
  totalCredit: string;
}

export class JournalError extends Error {
  override readonly name = 'JournalError';
}

/** Validates and normalises a journal; zero lines are dropped. Throws if it does not balance. */
export function balanceJournal<L extends JournalLineInput>(lines: readonly L[]): BalancedJournal<L> {
  let debit = new Dec(0);
  let credit = new Dec(0);
  const kept: L[] = [];
  for (const line of lines) {
    const d = dec(line.debit);
    const c = dec(line.credit);
    if ((d.isNegative() && !d.isZero()) || (c.isNegative() && !c.isZero())) throw new JournalError(`Negative amount on ${line.account}`);
    if (!d.times(100).isInteger() || !c.times(100).isInteger()) throw new JournalError(`More than 2 decimal places on ${line.account}`);
    if (!d.isZero() && !c.isZero()) throw new JournalError(`A line is either a debit or a credit (${line.account})`);
    if (d.isZero() && c.isZero()) continue;
    debit = debit.plus(d);
    credit = credit.plus(c);
    kept.push({ ...line, debit: money(d), credit: money(c) });
  }
  if (!debit.eq(credit)) throw new JournalError(`Journal does not balance: debit ${money(debit)}, credit ${money(credit)}`);
  return { lines: kept, totalDebit: money(debit), totalCredit: money(credit) };
}

/**
 * A two-sided posting of a signed amount: positive debits `whenPositive` and
 * credits the other account; negative swaps them.
 */
export function pair(amount: string, whenPositive: string, other: string): JournalLineInput[] {
  const a = dec(amount);
  if (a.isZero()) return [];
  const abs = money(a.abs());
  return a.isPositive()
    ? [
        { account: whenPositive, debit: abs, credit: '0.00' },
        { account: other, debit: '0.00', credit: abs },
      ]
    : [
        { account: other, debit: abs, credit: '0.00' },
        { account: whenPositive, debit: '0.00', credit: abs },
      ];
}

/** Merges lines per account and side (one debit and/or one credit line per account). */
export function consolidate(lines: readonly JournalLineInput[]): JournalLineInput[] {
  const byAccount = new Map<string, { debit: Dec; credit: Dec }>();
  for (const l of lines) {
    const cur = byAccount.get(l.account) ?? { debit: new Dec(0), credit: new Dec(0) };
    byAccount.set(l.account, { debit: cur.debit.plus(dec(l.debit)), credit: cur.credit.plus(dec(l.credit)) });
  }
  return [...byAccount].flatMap(([account, { debit, credit }]) => {
    // Net each account to one side, so a journal never debits and credits the same account.
    const net = debit.minus(credit);
    if (net.isZero()) return [];
    return [{ account, debit: net.isPositive() ? money(net) : '0.00', credit: net.isNegative() ? money(net.abs()) : '0.00' }];
  });
}
