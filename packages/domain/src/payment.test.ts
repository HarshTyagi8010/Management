import { describe, expect, it } from 'vitest';
import {
  calculateCustomerStatement,
  calculateNoteLineAmounts,
  calculateSupplierStatement,
  computeFifoAllocations,
  obligationPaymentStatus,
} from './payment.js';

describe('Payment & Allocation Domain', () => {
  it('FIFO allocation handles partial, exact, and excess allocations with deterministic tie-breaking', () => {
    const obligations = [
      { id: 'inv-3', docNumber: 'INV-003', docDate: '2026-10-15', dueDate: '2026-10-25', outstanding: '300.00' },
      { id: 'inv-1', docNumber: 'INV-001', docDate: '2026-10-01', dueDate: '2026-10-10', outstanding: '100.00' },
      { id: 'inv-2', docNumber: 'INV-002', docDate: '2026-10-01', dueDate: '2026-10-15', outstanding: '200.00' },
    ];

    // Allocate 250 against 100 + 200 + 300
    // Expected:
    // inv-1 gets 100.00 (remaining 0)
    // inv-2 gets 150.00 (remaining 50)
    // inv-3 gets 0
    const res = computeFifoAllocations('250.00', obligations);
    expect(res.totalAllocated).toBe('250.00');
    expect(res.remainingUnallocated).toBe('0.00');
    expect(res.allocations).toHaveLength(2);
    expect(res.allocations[0]).toEqual({
      targetId: 'inv-1',
      targetNumber: 'INV-001',
      amount: '100.00',
      newOutstanding: '0.00',
    });
    expect(res.allocations[1]).toEqual({
      targetId: 'inv-2',
      targetNumber: 'INV-002',
      amount: '150.00',
      newOutstanding: '50.00',
    });

    // Allocate 700 (excess)
    const resExcess = computeFifoAllocations('700.00', obligations);
    expect(resExcess.totalAllocated).toBe('600.00');
    expect(resExcess.remainingUnallocated).toBe('100.00');
    expect(resExcess.allocations).toHaveLength(3);
  });

  it('determines obligation payment status correctly', () => {
    expect(obligationPaymentStatus('100.00', '100.00')).toBe('unpaid');
    expect(obligationPaymentStatus('100.00', '50.00')).toBe('partially_paid');
    expect(obligationPaymentStatus('100.00', '0.00')).toBe('paid');
  });

  it('calculates note line taxes for intra and inter state correctly', () => {
    // 1000 @ 18% intra -> 90 CGST, 90 SGST
    const intra = calculateNoteLineAmounts('1000.00', '18', false);
    expect(intra.taxable).toBe('1000.00');
    expect(intra.cgst).toBe('90.00');
    expect(intra.sgst).toBe('90.00');
    expect(intra.igst).toBe('0.00');
    expect(intra.total).toBe('1180.00');

    // 1000 @ 18% inter -> 180 IGST
    const inter = calculateNoteLineAmounts('1000.00', '18', true);
    expect(inter.taxable).toBe('1000.00');
    expect(inter.cgst).toBe('0.00');
    expect(inter.sgst).toBe('0.00');
    expect(inter.igst).toBe('180.00');
    expect(inter.total).toBe('1180.00');
  });

  it('calculates customer running balances accurately', () => {
    const raw = [
      { date: '2026-10-01', docType: 'sales_invoice', docNumber: 'INV-1', description: 'Sale', debit: '1000.00', credit: '0.00' },
      { date: '2026-10-05', docType: 'payment', docNumber: 'REC-1', description: 'Receipt', debit: '0.00', credit: '600.00' },
      { date: '2026-10-10', docType: 'credit_note', docNumber: 'CN-1', description: 'Return', debit: '0.00', credit: '150.00' },
    ];
    const res = calculateCustomerStatement('200.00', raw);
    expect(res.openingBalance).toBe('200.00');
    // 200 + 1000 = 1200
    // 1200 - 600 = 600
    // 600 - 150 = 450
    expect(res.entries[0].runningBalance).toBe('1200.00');
    expect(res.entries[1].runningBalance).toBe('600.00');
    expect(res.entries[2].runningBalance).toBe('450.00');
    expect(res.closingBalance).toBe('450.00');
    expect(res.totalDebit).toBe('1000.00');
    expect(res.totalCredit).toBe('750.00');
  });

  it('calculates supplier running balances accurately', () => {
    const raw = [
      { date: '2026-10-01', docType: 'supplier_bill', docNumber: 'BILL-1', description: 'Bill', debit: '0.00', credit: '2000.00' },
      { date: '2026-10-08', docType: 'payment', docNumber: 'PMT-1', description: 'Disbursement', debit: '1500.00', credit: '0.00' },
      { date: '2026-10-12', docType: 'debit_note', docNumber: 'DN-1', description: 'Debit Note', debit: '200.00', credit: '0.00' },
    ];
    const res = calculateSupplierStatement('0.00', raw);
    // 0 + 2000 = 2000
    // 2000 - 1500 = 500
    // 500 - 200 = 300
    expect(res.entries[0].runningBalance).toBe('2000.00');
    expect(res.entries[1].runningBalance).toBe('500.00');
    expect(res.entries[2].runningBalance).toBe('300.00');
    expect(res.closingBalance).toBe('300.00');
  });
});
