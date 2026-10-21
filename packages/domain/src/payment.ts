import { dec, money, type Dec } from './decimal.js';

export interface ObligationCandidate {
  id: string;
  docNumber: string;
  docDate: string;
  dueDate: string | null;
  outstanding: string;
}

export interface FifoAllocationResult {
  allocations: Array<{
    targetId: string;
    targetNumber: string;
    amount: string;
    newOutstanding: string;
  }>;
  totalAllocated: string;
  remainingUnallocated: string;
}

/**
 * Deterministic FIFO allocation algorithm:
 * Orders open obligations by docDate ASC, dueDate ASC (nulls last), then id ASC.
 * Allocates available payment amount up to each obligation's outstanding balance.
 */
export function computeFifoAllocations(
  availableAmount: string,
  obligations: ReadonlyArray<ObligationCandidate>,
): FifoAllocationResult {
  let rem = dec(availableAmount);
  if (rem.isNegative() || rem.isZero()) {
    return {
      allocations: [],
      totalAllocated: '0.00',
      remainingUnallocated: '0.00',
    };
  }

  // Stable deterministic sort
  const sorted = [...obligations].sort((a, b) => {
    const dComp = a.docDate.localeCompare(b.docDate);
    if (dComp !== 0) return dComp;
    if (a.dueDate && b.dueDate) {
      const dueComp = a.dueDate.localeCompare(b.dueDate);
      if (dueComp !== 0) return dueComp;
    } else if (a.dueDate && !b.dueDate) {
      return -1;
    } else if (!a.dueDate && b.dueDate) {
      return 1;
    }
    return a.id.localeCompare(b.id);
  });

  const allocations: FifoAllocationResult['allocations'] = [];
  let totalAllocated = dec('0');

  for (const ob of sorted) {
    if (rem.isZero()) break;
    const out = dec(ob.outstanding);
    if (out.isNegative() || out.isZero()) continue;

    const toAlloc = rem.lessThan(out) ? rem : out;
    const newOut = out.minus(toAlloc);
    allocations.push({
      targetId: ob.id,
      targetNumber: ob.docNumber,
      amount: money(toAlloc),
      newOutstanding: money(newOut),
    });

    totalAllocated = totalAllocated.plus(toAlloc);
    rem = rem.minus(toAlloc);
  }

  return {
    allocations,
    totalAllocated: money(totalAllocated),
    remainingUnallocated: money(rem),
  };
}

/**
 * Returns updated payment status based on remaining unallocated amount.
 */
export function obligationPaymentStatus(grand: string, outstanding: string): 'unpaid' | 'partially_paid' | 'paid' {
  const g = dec(grand);
  const out = dec(outstanding);
  if (out.isZero() || out.isNegative()) return 'paid';
  if (out.greaterThanOrEqualTo(g)) return 'unpaid';
  return 'partially_paid';
}

/**
 * Calculates note line taxes and totals given taxable, rate, and intra/inter state.
 */
export function calculateNoteLineAmounts(
  taxable: string,
  gstRate: string | null,
  isInterState: boolean,
): {
  taxable: string;
  cgst: string;
  sgst: string;
  utgst: string;
  igst: string;
  cess: string;
  total: string;
} {
  const t = dec(taxable);
  if (!gstRate || dec(gstRate).isZero()) {
    return {
      taxable: money(t),
      cgst: '0.00',
      sgst: '0.00',
      utgst: '0.00',
      igst: '0.00',
      cess: '0.00',
      total: money(t),
    };
  }

  const rate = dec(gstRate);
  if (isInterState) {
    const igst = t.times(rate).dividedBy(100);
    return {
      taxable: money(t),
      cgst: '0.00',
      sgst: '0.00',
      utgst: '0.00',
      igst: money(igst),
      cess: '0.00',
      total: money(t.plus(igst)),
    };
  } else {
    const halfRate = rate.dividedBy(2);
    const cgst = t.times(halfRate).dividedBy(100);
    const sgst = t.times(halfRate).dividedBy(100);
    return {
      taxable: money(t),
      cgst: money(cgst),
      sgst: money(sgst),
      utgst: '0.00',
      igst: '0.00',
      cess: '0.00',
      total: money(t.plus(cgst).plus(sgst)),
    };
  }
}

export interface StatementRawEntry {
  date: string;
  docType: string;
  docNumber: string;
  description: string;
  debit: string;
  credit: string;
}

export interface StatementCalculatedEntry extends StatementRawEntry {
  runningBalance: string;
}

/**
 * Calculates running balances for customer statement (receivable: debit increases, credit decreases).
 */
export function calculateCustomerStatement(
  openingBalance: string,
  entries: ReadonlyArray<StatementRawEntry>,
): {
  openingBalance: string;
  entries: StatementCalculatedEntry[];
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
} {
  let bal = dec(openingBalance);
  let totalDebit = dec('0');
  let totalCredit = dec('0');

  const calculated: StatementCalculatedEntry[] = [];
  for (const e of entries) {
    const dr = dec(e.debit);
    const cr = dec(e.credit);
    totalDebit = totalDebit.plus(dr);
    totalCredit = totalCredit.plus(cr);
    bal = bal.plus(dr).minus(cr);

    calculated.push({
      ...e,
      debit: money(dr),
      credit: money(cr),
      runningBalance: money(bal),
    });
  }

  return {
    openingBalance: money(dec(openingBalance)),
    entries: calculated,
    closingBalance: money(bal),
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
  };
}

/**
 * Calculates running balances for supplier statement (payable: credit increases, debit decreases).
 */
export function calculateSupplierStatement(
  openingBalance: string,
  entries: ReadonlyArray<StatementRawEntry>,
): {
  openingBalance: string;
  entries: StatementCalculatedEntry[];
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
} {
  let bal = dec(openingBalance);
  let totalDebit = dec('0');
  let totalCredit = dec('0');

  const calculated: StatementCalculatedEntry[] = [];
  for (const e of entries) {
    const dr = dec(e.debit);
    const cr = dec(e.credit);
    totalDebit = totalDebit.plus(dr);
    totalCredit = totalCredit.plus(cr);
    bal = bal.plus(cr).minus(dr);

    calculated.push({
      ...e,
      debit: money(dr),
      credit: money(cr),
      runningBalance: money(bal),
    });
  }

  return {
    openingBalance: money(dec(openingBalance)),
    entries: calculated,
    closingBalance: money(bal),
    totalDebit: money(totalDebit),
    totalCredit: money(totalCredit),
  };
}


