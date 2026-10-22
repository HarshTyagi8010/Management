import { trusted, Types, type ClientSession } from 'mongoose';
import {
  type FinancialReconciliationQuery,
  type FinancialReconciliationResponse,
  type ReconciliationStatus,
} from '@bizmgmt/contracts';
import { dec, money } from '@bizmgmt/domain';
import type { Models } from '../../models.js';
import { fromDecimal, todayIST } from '../../platform/values.js';
import { withTransaction } from '../../platform/transactions.js';

export interface ReconciliationDeps {
  models: Models;
  now?: (() => Date) | undefined;
}

export class ReconciliationService {
  constructor(private readonly deps: ReconciliationDeps) {}

  private get models() {
    return this.deps.models;
  }

  /**
   * Authoritative financial reconciliation (Batch B).
   * Verifies journal balancing, posting relationships, subledger AR/AP control accounts,
   * advances, note-origin non-cash credits, inventory valuation, and GST tax accounts.
   */
  async reconcileFinancial(
    tenantId: Types.ObjectId,
    query: FinancialReconciliationQuery,
  ): Promise<FinancialReconciliationResponse> {
    const legalEntityId = new Types.ObjectId(query.legalEntityId);
    const today = todayIST(this.deps.now?.());
    const asOfDate = query.asOfDate ?? today;
    const mode = query.mode;

    // Reject unsupported historical reconstruction where mutable fields cannot be rewound
    if (mode === 'historical' || (query.asOfDate && query.asOfDate < today)) {
      return this.buildUnsupportedHistoricalResponse(legalEntityId, mode, asOfDate);
    }

    // Execute in a snapshot-isolated transaction to guarantee read consistency across all collections
    return await withTransaction(this.models.Journal.db, async (session) => {
      // 1. Check for empty dataset
      const journalCount = await this.models.Journal.countDocuments(
        { tenantId, legalEntityId },
        { session },
      );
      const invoiceCount = await this.models.SalesInvoice.countDocuments(
        { tenantId, legalEntityId, status: trusted({ $in: ['issued', 'cancelled'] }) },
        { session },
      );
      const billCount = await this.models.SupplierBill.countDocuments(
        { tenantId, legalEntityId, status: trusted({ $in: ['posted', 'cancelled'] }) },
        { session },
      );
      const paymentCount = await this.models.Payment.countDocuments(
        { tenantId, legalEntityId, status: trusted({ $in: ['posted', 'reversed'] }) },
        { session },
      );
      const valuationCount = await this.models.ItemValuation.countDocuments(
        { tenantId, legalEntityId },
        { session },
      );

      const isEmpty =
        journalCount === 0 &&
        invoiceCount === 0 &&
        billCount === 0 &&
        paymentCount === 0 &&
        valuationCount === 0;

      if (isEmpty) {
        return this.buildEmptyDatasetResponse(legalEntityId, mode, asOfDate);
      }

      // 2. Journal Integrity & Posting Relationships
      const journalSection = await this.reconcileJournalIntegrity(tenantId, legalEntityId, session);

      // 3. Trade Receivables (GL 1200 vs Subledger AR)
      const arSection = await this.reconcileTradeReceivables(tenantId, legalEntityId, session);

      // 4. Trade Payables (GL 2100 vs Subledger AP)
      const apSection = await this.reconcileTradePayables(tenantId, legalEntityId, session);

      // 5. Customer Advances (GL 2300 vs Subledger Advances)
      const advSection = await this.reconcileCustomerAdvances(tenantId, legalEntityId, session);

      // 6. Inventory Valuation (GL 1300 vs ItemValuation)
      const invSection = await this.reconcileInventoryValuation(tenantId, legalEntityId, session);

      // 7. Tax Accounts (GL 1410-1413, 2210-2213 vs Document Taxes)
      const taxSection = await this.reconcileTaxAccounts(tenantId, legalEntityId, session);

      // Bounded drill-down if requested
      const drillDown = query.drillDown
        ? await this.buildDrillDown(tenantId, legalEntityId, session)
        : undefined;

      const allSections: Array<{ status: ReconciliationStatus }> = [
        journalSection,
        arSection,
        apSection,
        advSection,
        invSection,
        taxSection,
      ];

      const matchedCount = allSections.filter((s) => s.status === 'MATCHED').length;
      const mismatchedCount = allSections.filter((s) => s.status === 'MISMATCH').length;
      const incompleteCount = allSections.filter((s) => s.status === 'INCOMPLETE').length;
      const unsupportedCount = allSections.filter((s) => s.status === 'UNSUPPORTED').length;

      const overallStatus: ReconciliationStatus =
        mismatchedCount > 0
          ? 'MISMATCH'
          : incompleteCount > 0
            ? 'INCOMPLETE'
            : unsupportedCount > 0
              ? 'UNSUPPORTED'
              : 'MATCHED';

      return {
        legalEntityId: legalEntityId.toHexString(),
        currency: 'INR',
        mode,
        asOfDate,
        generatedAt: (this.deps.now ? this.deps.now() : new Date()).toISOString(),
        reconciliationVersion: '1.0',
        status: overallStatus,
        summary: {
          totalSections: allSections.length,
          matchedSections: matchedCount,
          mismatchedSections: mismatchedCount,
          incompleteSections: incompleteCount,
          unsupportedSections: unsupportedCount,
          emptyDataset: false,
        },
        unsupportedConditions: [],
        sections: {
          journalIntegrity: journalSection,
          tradeReceivables: arSection,
          tradePayables: apSection,
          customerAdvances: advSection,
          inventoryValuation: invSection,
          taxAccounts: taxSection,
        },
        ...(drillDown ? { drillDown } : {}),
      };
    });
  }

  // --------------------------------------------------------------------------
  // 1. Journal Integrity & Posting Relationships
  // --------------------------------------------------------------------------
  private async reconcileJournalIntegrity(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const issues: Array<{
      kind: string;
      journalId?: string | null;
      sourceId?: string | null;
      detail: string;
    }> = [];

    const journals = await this.models.Journal.find(
      { tenantId, legalEntityId },
      null,
      { session },
    ).lean();

    let balancedCount = 0;
    let unbalancedCount = 0;

    const journalsBySource = new Map<string, typeof journals>();

    for (const j of journals) {
      let dSum = dec('0');
      let cSum = dec('0');

      for (const l of j.lines) {
        const d = dec(l.debit.toString());
        const c = dec(l.credit.toString());
        if (d.isNegative() || c.isNegative() || (!d.isZero() && !c.isZero())) {
          issues.push({
            kind: 'bad_line',
            journalId: j._id.toHexString(),
            sourceId: j.sourceId.toHexString(),
            detail: `Line on account ${l.accountCode} is negative or two-sided`,
          });
        }
        dSum = dSum.plus(d);
        cSum = cSum.plus(c);
      }

      if (!dSum.eq(cSum)) {
        unbalancedCount++;
        issues.push({
          kind: 'unbalanced',
          journalId: j._id.toHexString(),
          sourceId: j.sourceId.toHexString(),
          detail: `Debit ₹${money(dSum)} does not balance credit ₹${money(cSum)}`,
        });
      } else {
        balancedCount++;
      }

      if (!dSum.eq(dec(j.totalDebit.toString())) || !cSum.eq(dec(j.totalCredit.toString()))) {
        issues.push({
          kind: 'totals_mismatch',
          journalId: j._id.toHexString(),
          sourceId: j.sourceId.toHexString(),
          detail: 'Stored totalDebit or totalCredit does not match sum of lines',
        });
      }

      const key = `${j.sourceType}:${j.sourceId.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      group.push(j);
      journalsBySource.set(key, group);
    }

    // Check duplicate postings: more than one original (non-reversal) journal for a single sourceId
    let duplicatePostings = 0;
    for (const [key, group] of journalsBySource.entries()) {
      const originals = group.filter((j) => j.reversalOf === null);
      if (originals.length > 1 && originals[0]) {
        duplicatePostings += originals.length - 1;
        issues.push({
          kind: 'duplicate_posting',
          sourceId: originals[0].sourceId.toHexString(),
          detail: `Multiple (${originals.length}) non-reversal journals found for source ${key}`,
        });
      }
    }

    // Check missing postings for operational documents
    let missingPostings = 0;

    // A. Sales Invoices
    const invoices = await this.models.SalesInvoice.find(
      { tenantId, legalEntityId, status: trusted({ $in: ['issued', 'cancelled'] }) },
      { _id: 1, number: 1, status: 1 },
      { session },
    ).lean();

    for (const inv of invoices) {
      const key = `sales_invoice:${inv._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: inv._id.toHexString(),
          detail: `Issued sales invoice ${inv.number} has no active journal`,
        });
      }
      if (inv.status === 'cancelled') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: inv._id.toHexString(),
            detail: `Cancelled sales invoice ${inv.number} has no reversal journal`,
          });
        }
      }
    }

    // B. Supplier Bills
    const bills = await this.models.SupplierBill.find(
      { tenantId, legalEntityId, status: trusted({ $in: ['posted', 'cancelled'] }) },
      { _id: 1, number: 1, status: 1 },
      { session },
    ).lean();

    for (const b of bills) {
      const key = `supplier_bill:${b._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: b._id.toHexString(),
          detail: `Posted supplier bill ${b.number} has no active journal`,
        });
      }
      if (b.status === 'cancelled') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: b._id.toHexString(),
            detail: `Cancelled supplier bill ${b.number} has no reversal journal`,
          });
        }
      }
    }

    // C. Payments (excluding note excess pseudo-payments which do not generate standalone cash journals)
    const payments = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        recordKind: 'payment',
        status: trusted({ $in: ['posted', 'reversed'] }),
      },
      { _id: 1, number: 1, status: 1 },
      { session },
    ).lean();

    for (const p of payments) {
      const key = `payment:${p._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: p._id.toHexString(),
          detail: `Posted payment ${p.number} has no active journal`,
        });
      }
      if (p.status === 'reversed') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: p._id.toHexString(),
            detail: `Reversed payment ${p.number} has no reversal journal`,
          });
        }
      }
    }

    // D. Credit Notes
    const creditNotes = await this.models.CreditNote.find(
      { tenantId, legalEntityId, status: trusted({ $in: ['issued', 'cancelled'] }) },
      { _id: 1, number: 1, status: 1 },
      { session },
    ).lean();

    for (const cn of creditNotes) {
      const key = `credit_note:${cn._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: cn._id.toHexString(),
          detail: `Issued credit note ${cn.number} has no active journal`,
        });
      }
      if (cn.status === 'cancelled') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: cn._id.toHexString(),
            detail: `Cancelled credit note ${cn.number} has no reversal journal`,
          });
        }
      }
    }

    // E. Debit Notes
    const debitNotes = await this.models.DebitNote.find(
      { tenantId, legalEntityId, status: trusted({ $in: ['issued', 'cancelled'] }) },
      { _id: 1, number: 1, status: 1 },
      { session },
    ).lean();

    for (const dn of debitNotes) {
      const key = `debit_note:${dn._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: dn._id.toHexString(),
          detail: `Issued debit note ${dn.number} has no active journal`,
        });
      }
      if (dn.status === 'cancelled') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: dn._id.toHexString(),
            detail: `Cancelled debit note ${dn.number} has no reversal journal`,
          });
        }
      }
    }

    // F. Customer Receipt Allocations (excluding note-origin non-cash excess credits)
    const customerAllocations = await this.models.Allocation.find(
      { tenantId, legalEntityId, targetType: 'sales_invoice', status: trusted({ $in: ['active', 'cancelled'] }) },
      { _id: 1, paymentId: 1, targetNumber: 1, status: 1 },
      { session },
    ).lean();

    const cashReceiptIds = new Set(
      (
        await this.models.Payment.find(
          { tenantId, legalEntityId, recordKind: 'payment', direction: 'incoming' },
          { _id: 1 },
          { session },
        ).lean()
      ).map((p) => p._id.toHexString()),
    );

    for (const a of customerAllocations) {
      if (!cashReceiptIds.has(a.paymentId.toHexString())) continue;
      const key = `allocation:${a._id.toHexString()}`;
      const group = journalsBySource.get(key) ?? [];
      const original = group.find((j) => j.reversalOf === null);
      if (!original) {
        missingPostings++;
        issues.push({
          kind: 'missing_posting',
          sourceId: a._id.toHexString(),
          detail: `Active allocation to invoice ${a.targetNumber} has no allocation journal`,
        });
      }
      if (a.status === 'cancelled') {
        const reversal = group.find((j) => j.reversalOf !== null);
        if (!reversal) {
          missingPostings++;
          issues.push({
            kind: 'missing_posting',
            sourceId: a._id.toHexString(),
            detail: `Cancelled allocation to invoice ${a.targetNumber} has no reversal journal`,
          });
        }
      }
    }

    const status: ReconciliationStatus = issues.length === 0 ? 'MATCHED' : 'MISMATCH';

    return {
      name: 'Journal Balancing & Posting Integrity',
      status,
      journalsChecked: journals.length,
      balancedJournals: balancedCount,
      unbalancedJournals: unbalancedCount,
      missingPostings,
      duplicatePostings,
      orphanedJournals: 0,
      issues,
    };
  }

  // --------------------------------------------------------------------------
  // 2. Trade Receivables (GL 1200 vs Subledger AR)
  // --------------------------------------------------------------------------
  private async reconcileTradeReceivables(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const glNet = await this.getGlNetBalance(tenantId, legalEntityId, '1200', 'asset', session);

    // Subledger:
    // A. Outstanding on issued sales invoices
    const activeInvoices = await this.models.SalesInvoice.find(
      { tenantId, legalEntityId, status: 'issued' },
      { outstanding: 1 },
      { session },
    ).lean();

    let invoicesOutstanding = dec('0');
    for (const inv of activeInvoices) {
      invoicesOutstanding = invoicesOutstanding.plus(dec(inv.outstanding?.toString() ?? '0'));
    }

    // B. Unallocated non-cash credit note excess credits
    const excessCredits = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        recordKind: 'credit_note_excess',
        status: 'posted',
      },
      { unallocatedAmount: 1 },
      { session },
    ).lean();

    let unallocatedCnExcess = dec('0');
    for (const ec of excessCredits) {
      unallocatedCnExcess = unallocatedCnExcess.plus(dec(ec.unallocatedAmount.toString()));
    }

    const subledgerBalance = money(invoicesOutstanding.minus(unallocatedCnExcess));
    const glBalance = money(glNet);
    const diff = money(dec(subledgerBalance).minus(dec(glBalance)));
    const status: ReconciliationStatus = dec(diff).isZero() ? 'MATCHED' : 'MISMATCH';

    const diagnostics: string[] = [];
    if (!dec(diff).isZero()) {
      diagnostics.push(
        `Subledger AR (₹${subledgerBalance}) does not match GL Account 1200 (₹${glBalance}). Discrepancy: ₹${diff}.`,
      );
    }

    return {
      name: 'Trade Receivables (AR Control vs Subledger)',
      glAccount: '1200' as const,
      status,
      glBalance,
      subledgerBalance,
      difference: diff,
      breakdown: {
        issuedInvoicesOutstanding: money(invoicesOutstanding),
        unallocatedCreditNoteExcess: money(unallocatedCnExcess),
        advancesAllocatedToInvoices: '0.00',
        invoicesCount: activeInvoices.length,
        creditNotesCount: excessCredits.length,
      },
      diagnostics,
    };
  }

  // --------------------------------------------------------------------------
  // 3. Trade Payables (GL 2100 vs Subledger AP)
  // --------------------------------------------------------------------------
  private async reconcileTradePayables(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const glNet = await this.getGlNetBalance(tenantId, legalEntityId, '2100', 'liability', session);

    // Subledger:
    // A. Outstanding on posted supplier bills
    const activeBills = await this.models.SupplierBill.find(
      { tenantId, legalEntityId, status: 'posted' },
      { outstanding: 1 },
      { session },
    ).lean();

    let billsOutstanding = dec('0');
    for (const b of activeBills) {
      billsOutstanding = billsOutstanding.plus(dec(b.outstanding.toString()));
    }

    // B. Unallocated cash disbursements
    const cashDisbursements = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        direction: 'outgoing',
        recordKind: 'payment',
        status: 'posted',
      },
      { unallocatedAmount: 1 },
      { session },
    ).lean();

    let unallocatedDisbursements = dec('0');
    for (const p of cashDisbursements) {
      unallocatedDisbursements = unallocatedDisbursements.plus(dec(p.unallocatedAmount.toString()));
    }

    // C. Unallocated debit note excess
    const excessDebits = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        direction: 'outgoing',
        recordKind: 'debit_note_excess',
        status: 'posted',
      },
      { unallocatedAmount: 1 },
      { session },
    ).lean();

    let unallocatedDnExcess = dec('0');
    for (const d of excessDebits) {
      unallocatedDnExcess = unallocatedDnExcess.plus(dec(d.unallocatedAmount.toString()));
    }

    // D. Direct expenses posted to Trade Payables (paymentMode === 'payable')
    const payableExpenses = await this.models.Expense.find(
      {
        tenantId,
        legalEntityId,
        status: 'posted',
        paymentMode: 'payable',
      },
      { amount: 1 },
      { session },
    ).lean();

    let accruedExpenses = dec('0');
    for (const exp of payableExpenses) {
      accruedExpenses = accruedExpenses.plus(dec(fromDecimal(exp.amount) ?? '0'));
    }

    const subledgerBalance = money(
      billsOutstanding.plus(accruedExpenses).minus(unallocatedDisbursements).minus(unallocatedDnExcess),
    );
    const glBalance = money(glNet);
    const diff = money(dec(subledgerBalance).minus(dec(glBalance)));
    const status: ReconciliationStatus = dec(diff).isZero() ? 'MATCHED' : 'MISMATCH';

    const diagnostics: string[] = [];
    if (!dec(diff).isZero()) {
      diagnostics.push(
        `Subledger AP (₹${subledgerBalance}) does not match GL Account 2100 (₹${glBalance}). Discrepancy: ₹${diff}.`,
      );
    }

    return {
      name: 'Trade Payables (AP Control vs Subledger)',
      glAccount: '2100' as const,
      status,
      glBalance,
      subledgerBalance,
      difference: diff,
      breakdown: {
        postedBillsOutstanding: money(billsOutstanding),
        accruedExpenses: money(accruedExpenses),
        unallocatedDisbursements: money(unallocatedDisbursements),
        unallocatedDebitNoteExcess: money(unallocatedDnExcess),
        billsCount: activeBills.length,
        expensesCount: payableExpenses.length,
        paymentsCount: cashDisbursements.length,
        debitNotesCount: excessDebits.length,
      },
      diagnostics,
    };
  }

  // --------------------------------------------------------------------------
  // 4. Customer Advances (GL 2300 vs Subledger Customer Advances)
  // --------------------------------------------------------------------------
  private async reconcileCustomerAdvances(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const glNet = await this.getGlNetBalance(tenantId, legalEntityId, '2300', 'liability', session);

    // Subledger:
    // A. Unallocated cash receipt advances
    const activeReceipts = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        direction: 'incoming',
        recordKind: 'payment',
        status: 'posted',
      },
      { unallocatedAmount: 1 },
      { session },
    ).lean();

    let unallocatedAdvances = dec('0');
    for (const r of activeReceipts) {
      unallocatedAdvances = unallocatedAdvances.plus(dec(r.unallocatedAmount.toString()));
    }

    const subledgerBalance = money(unallocatedAdvances);
    const glBalance = money(glNet);
    const diff = money(dec(subledgerBalance).minus(dec(glBalance)));
    const status: ReconciliationStatus = dec(diff).isZero() ? 'MATCHED' : 'MISMATCH';

    const diagnostics: string[] = [];
    if (!dec(diff).isZero()) {
      diagnostics.push(
        `Subledger Customer Advances (₹${subledgerBalance}) does not match GL Account 2300 (₹${glBalance}). Discrepancy: ₹${diff}.`,
      );
    }

    return {
      name: 'Customer Advances (Control vs Subledger)',
      glAccount: '2300' as const,
      status,
      glBalance,
      subledgerBalance,
      difference: diff,
      breakdown: {
        unallocatedReceiptAdvances: money(unallocatedAdvances),
        allocatedAdvances: '0.00',
        receiptsCount: activeReceipts.length,
      },
      diagnostics,
    };
  }

  // --------------------------------------------------------------------------
  // 5. Inventory Valuation (GL 1300 vs ItemValuation)
  // --------------------------------------------------------------------------
  private async reconcileInventoryValuation(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const glNet = await this.getGlNetBalance(tenantId, legalEntityId, '1300', 'asset', session);

    const valuations = await this.models.ItemValuation.find(
      { tenantId, legalEntityId },
      { value: 1 },
      { session },
    ).lean();

    let stockValuation = dec('0');
    for (const v of valuations) {
      stockValuation = stockValuation.plus(dec(fromDecimal(v.value) ?? '0.00'));
    }

    const subledgerBalance = money(stockValuation);
    const glBalance = money(glNet);
    const diff = money(dec(subledgerBalance).minus(dec(glBalance)));
    const status: ReconciliationStatus = dec(diff).isZero() ? 'MATCHED' : 'MISMATCH';

    const diagnostics: string[] = [];
    if (!dec(diff).isZero()) {
      diagnostics.push(
        `Stock Valuation (₹${subledgerBalance}) does not match GL Account 1300 (₹${glBalance}). Discrepancy: ₹${diff}.`,
      );
    }

    return {
      name: 'Inventory Asset vs Stock Valuation',
      glAccount: '1300' as const,
      status,
      glBalance,
      subledgerBalance,
      difference: diff,
      breakdown: {
        valuationItemsCount: valuations.length,
      },
      diagnostics,
    };
  }

  // --------------------------------------------------------------------------
  // 6. Tax Accounts (Input 1410-1413 & Output 2210-2213)
  // --------------------------------------------------------------------------
  private async reconcileTaxAccounts(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const taxCodes = [
      { code: '2210', name: 'Output CGST', type: 'liability' as const, component: 'cgst' as const, dir: 'output' as const },
      { code: '2211', name: 'Output SGST/UTGST', type: 'liability' as const, component: 'sgst_utgst' as const, dir: 'output' as const },
      { code: '2212', name: 'Output IGST', type: 'liability' as const, component: 'igst' as const, dir: 'output' as const },
      { code: '2213', name: 'Output Cess', type: 'liability' as const, component: 'cess' as const, dir: 'output' as const },
      { code: '1410', name: 'Input CGST', type: 'asset' as const, component: 'cgst' as const, dir: 'input' as const },
      { code: '1411', name: 'Input SGST/UTGST', type: 'asset' as const, component: 'sgst_utgst' as const, dir: 'input' as const },
      { code: '1412', name: 'Input IGST', type: 'asset' as const, component: 'igst' as const, dir: 'input' as const },
      { code: '1413', name: 'Input Cess', type: 'asset' as const, component: 'cess' as const, dir: 'input' as const },
    ];

    // Compute expected tax from source operational documents
    // A. Output Tax Sources (Sales Invoices minus Credit Notes)
    const activeInvoices = await this.models.SalesInvoice.find(
      { tenantId, legalEntityId, status: 'issued' },
      { totals: 1 },
      { session },
    ).lean();

    const activeCreditNotes = await this.models.CreditNote.find(
      { tenantId, legalEntityId, status: 'issued' },
      { amounts: 1 },
      { session },
    ).lean();

    const expectedOutput = {
      cgst: dec('0'),
      sgst_utgst: dec('0'),
      igst: dec('0'),
      cess: dec('0'),
    };

    for (const inv of activeInvoices) {
      expectedOutput.cgst = expectedOutput.cgst.plus(dec(fromDecimal(inv.totals.cgst) ?? '0'));
      expectedOutput.sgst_utgst = expectedOutput.sgst_utgst
        .plus(dec(fromDecimal(inv.totals.sgst) ?? '0'))
        .plus(dec(fromDecimal(inv.totals.utgst) ?? '0'));
      expectedOutput.igst = expectedOutput.igst.plus(dec(fromDecimal(inv.totals.igst) ?? '0'));
      expectedOutput.cess = expectedOutput.cess.plus(dec(fromDecimal(inv.totals.cess) ?? '0'));
    }

    for (const cn of activeCreditNotes) {
      expectedOutput.cgst = expectedOutput.cgst.minus(dec(fromDecimal(cn.amounts.cgst) ?? '0'));
      expectedOutput.sgst_utgst = expectedOutput.sgst_utgst
        .minus(dec(fromDecimal(cn.amounts.sgst) ?? '0'))
        .minus(dec(fromDecimal(cn.amounts.utgst) ?? '0'));
      expectedOutput.igst = expectedOutput.igst.minus(dec(fromDecimal(cn.amounts.igst) ?? '0'));
      expectedOutput.cess = expectedOutput.cess.minus(dec(fromDecimal(cn.amounts.cess) ?? '0'));
    }

    // B. Input Tax Sources (ITC-Eligible Supplier Bills & Direct Expenses minus ITC-Eligible Debit Notes)
    const itcBills = await this.models.SupplierBill.find(
      { tenantId, legalEntityId, status: 'posted', itcEligible: trusted({ $ne: false }) },
      { totals: 1 },
      { session },
    ).lean();

    const itcExpenses = await this.models.Expense.find(
      { tenantId, legalEntityId, status: 'posted', itcEligible: true },
      { taxAmount: 1 },
      { session },
    ).lean();

    const issuedDebitNotes = await this.models.DebitNote.find(
      { tenantId, legalEntityId, status: 'issued' },
      { amounts: 1, supplierBillId: 1 },
      { session },
    ).lean();

    const debitedBillIds = issuedDebitNotes.map((d) => d.supplierBillId);
    const itcBillIdSet = new Set(
      (
        await this.models.SupplierBill.find(
          { tenantId, legalEntityId, _id: trusted({ $in: debitedBillIds }), itcEligible: trusted({ $ne: false }) },
          { _id: 1 },
          { session },
        ).lean()
      ).map((b) => b._id.toHexString()),
    );

    const itcDebitNotes = issuedDebitNotes.filter((d) => itcBillIdSet.has(d.supplierBillId.toHexString()));

    const expectedInput = {
      cgst: dec('0'),
      sgst_utgst: dec('0'),
      igst: dec('0'),
      cess: dec('0'),
    };

    for (const b of itcBills) {
      expectedInput.cgst = expectedInput.cgst.plus(dec(fromDecimal(b.totals.cgst) ?? '0'));
      expectedInput.sgst_utgst = expectedInput.sgst_utgst
        .plus(dec(fromDecimal(b.totals.sgst) ?? '0'))
        .plus(dec(fromDecimal(b.totals.utgst) ?? '0'));
      expectedInput.igst = expectedInput.igst.plus(dec(fromDecimal(b.totals.igst) ?? '0'));
      expectedInput.cess = expectedInput.cess.plus(dec(fromDecimal(b.totals.cess) ?? '0'));
    }

    for (const e of itcExpenses) {
      const taxAmt = dec(fromDecimal(e.taxAmount) ?? '0');
      if (!taxAmt.isZero()) {
        const half = dec(money(taxAmt.dividedBy(2)));
        expectedInput.cgst = expectedInput.cgst.plus(half);
        expectedInput.sgst_utgst = expectedInput.sgst_utgst.plus(taxAmt.minus(half));
      }
    }

    for (const dn of itcDebitNotes) {
      expectedInput.cgst = expectedInput.cgst.minus(dec(fromDecimal(dn.amounts.cgst) ?? '0'));
      expectedInput.sgst_utgst = expectedInput.sgst_utgst
        .minus(dec(fromDecimal(dn.amounts.sgst) ?? '0'))
        .minus(dec(fromDecimal(dn.amounts.utgst) ?? '0'));
      expectedInput.igst = expectedInput.igst.minus(dec(fromDecimal(dn.amounts.igst) ?? '0'));
      expectedInput.cess = expectedInput.cess.minus(dec(fromDecimal(dn.amounts.cess) ?? '0'));
    }

    const subAccounts: FinancialReconciliationResponse['sections']['taxAccounts']['subAccounts'] = [];
    const diagnostics: string[] = [];

    let totalGl = dec('0');
    let totalExpected = dec('0');

    for (const item of taxCodes) {
      const gl = await this.getGlNetBalance(tenantId, legalEntityId, item.code, item.type, session);
      const expected = item.dir === 'output' ? expectedOutput[item.component] : expectedInput[item.component];

      const diff = money(expected.minus(gl));
      const isMatch = dec(diff).isZero();
      const status: ReconciliationStatus = isMatch ? 'MATCHED' : 'MISMATCH';

      if (!isMatch) {
        diagnostics.push(
          `${item.name} (${item.code}): Expected ₹${money(expected)} vs GL ₹${money(gl)}. Discrepancy: ₹${diff}.`,
        );
      }

      totalGl = totalGl.plus(gl);
      totalExpected = totalExpected.plus(expected);

      subAccounts.push({
        accountCode: item.code,
        name: item.name,
        glBalance: money(gl),
        expectedBalance: money(expected),
        difference: diff,
        status,
      });
    }

    // Detect unsupported/manual journal entries touching tax accounts
    const unsupportedTaxJournals = await this.models.Journal.find(
      {
        tenantId,
        legalEntityId,
        'lines.accountCode': trusted({ $in: taxCodes.map((t) => t.code) }),
        sourceType: trusted({ $nin: ['sales_invoice', 'credit_note', 'supplier_bill', 'expense', 'debit_note'] }),
      },
      { sourceNumber: 1, sourceType: 1 },
      { session },
    ).lean();

    for (const uj of unsupportedTaxJournals) {
      diagnostics.push(
        `Unsupported or manual journal entry found on tax accounts: ${uj.sourceNumber} (source: ${uj.sourceType})`,
      );
    }

    const overallDiff = money(totalExpected.minus(totalGl));
    const overallStatus: ReconciliationStatus =
      dec(overallDiff).isZero() && unsupportedTaxJournals.length === 0 ? 'MATCHED' : 'MISMATCH';

    return {
      name: 'GST Input & Output Tax Control Accounts',
      status: overallStatus,
      glBalance: money(totalGl),
      subledgerBalance: money(totalExpected),
      difference: overallDiff,
      subAccounts,
      diagnostics,
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  private async getGlNetBalance(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    accountCode: string,
    accountType: 'asset' | 'liability',
    session: ClientSession,
  ): Promise<ReturnType<typeof dec>> {
    const rows = await this.models.Journal.aggregate<{ _id: null; debit: unknown; credit: unknown }>([
      { $match: { tenantId, legalEntityId } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountCode': accountCode } },
      { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]).session(session);

    if (rows.length === 0 || !rows[0]) return dec('0');
    const d = dec(String(rows[0].debit ?? '0'));
    const c = dec(String(rows[0].credit ?? '0'));

    return accountType === 'asset' ? d.minus(c) : c.minus(d);
  }

  private async buildDrillDown(
    tenantId: Types.ObjectId,
    legalEntityId: Types.ObjectId,
    session: ClientSession,
  ) {
    const invoices = await this.models.SalesInvoice.find(
      { tenantId, legalEntityId, status: 'issued' },
      { _id: 1, number: 1, partyName: 1, docDate: 1, totals: 1, outstanding: 1 },
      { session, limit: 50 },
    ).lean();

    const bills = await this.models.SupplierBill.find(
      { tenantId, legalEntityId, status: 'posted' },
      { _id: 1, number: 1, supplierName: 1, docDate: 1, totals: 1, outstanding: 1 },
      { session, limit: 50 },
    ).lean();

    const allAdvances = await this.models.Payment.find(
      {
        tenantId,
        legalEntityId,
        direction: 'incoming',
        recordKind: 'payment',
        status: 'posted',
      },
      { _id: 1, number: 1, partyName: 1, docDate: 1, amount: 1, unallocatedAmount: 1 },
      { session, limit: 100 },
    ).lean();

    const advances = allAdvances
      .filter((a) => dec(a.unallocatedAmount.toString()).isPositive())
      .slice(0, 50);

    return {
      receivables: invoices.map((i) => ({
        id: i._id.toHexString(),
        number: i.number ?? '',
        partyName: i.partyName,
        docDate: i.docDate,
        grand: fromDecimal(i.totals.grand) ?? '0.00',
        outstanding: i.outstanding?.toString() ?? '0.00',
      })),
      payables: bills.map((b) => ({
        id: b._id.toHexString(),
        number: b.number ?? null,
        partyName: b.supplierName,
        docDate: b.docDate,
        grand: fromDecimal(b.totals.grand) ?? '0.00',
        outstanding: b.outstanding.toString(),
      })),
      advances: advances.map((a) => ({
        id: a._id.toHexString(),
        number: a.number ?? null,
        partyName: a.partyName,
        docDate: a.docDate,
        amount: fromDecimal(a.amount) ?? '0.00',
        unallocatedAmount: a.unallocatedAmount.toString(),
      })),
    };
  }

  private buildUnsupportedHistoricalResponse(
    legalEntityId: Types.ObjectId,
    mode: 'current' | 'historical',
    asOfDate: string,
  ): FinancialReconciliationResponse {
    const unsuppSection = (name: string, glAccount?: any) => ({
      name,
      ...(glAccount ? { glAccount } : {}),
      status: 'UNSUPPORTED' as const,
      glBalance: '0.00',
      subledgerBalance: '0.00',
      difference: '0.00',
      breakdown: {} as any,
      diagnostics: ['Historical point-in-time reconstruction is unsupported.'],
    });

    return {
      legalEntityId: legalEntityId.toHexString(),
      currency: 'INR',
      mode,
      asOfDate,
      generatedAt: (this.deps.now ? this.deps.now() : new Date()).toISOString(),
      reconciliationVersion: '1.0',
      status: 'UNSUPPORTED',
      summary: {
        totalSections: 6,
        matchedSections: 0,
        mismatchedSections: 0,
        incompleteSections: 0,
        unsupportedSections: 6,
        emptyDataset: false,
      },
      unsupportedConditions: [
        'HISTORICAL_RECONSTRUCTION_UNSUPPORTED: Point-in-time retrospective subledger reconstruction is unsupported due to in-place mutable balances on obligations and payments. Run current-state reconciliation instead.',
      ],
      sections: {
        journalIntegrity: {
          name: 'Journal Balancing & Posting Integrity',
          status: 'UNSUPPORTED',
          journalsChecked: 0,
          balancedJournals: 0,
          unbalancedJournals: 0,
          missingPostings: 0,
          duplicatePostings: 0,
          orphanedJournals: 0,
          issues: [],
        },
        tradeReceivables: unsuppSection('Trade Receivables (AR Control vs Subledger)', '1200') as any,
        tradePayables: unsuppSection('Trade Payables (AP Control vs Subledger)', '2100') as any,
        customerAdvances: unsuppSection('Customer Advances (Control vs Subledger)', '2300') as any,
        inventoryValuation: unsuppSection('Inventory Asset vs Stock Valuation', '1300') as any,
        taxAccounts: {
          name: 'GST Input & Output Tax Control Accounts',
          status: 'UNSUPPORTED',
          glBalance: '0.00',
          subledgerBalance: '0.00',
          difference: '0.00',
          subAccounts: [],
          diagnostics: ['Historical point-in-time reconstruction is unsupported.'],
        },
      },
    };
  }

  private buildEmptyDatasetResponse(
    legalEntityId: Types.ObjectId,
    mode: 'current' | 'historical',
    asOfDate: string,
  ): FinancialReconciliationResponse {
    const emptySection = (name: string, glAccount?: any) => ({
      name,
      ...(glAccount ? { glAccount } : {}),
      status: 'INCOMPLETE' as const,
      glBalance: '0.00',
      subledgerBalance: '0.00',
      difference: '0.00',
      breakdown: {
        issuedInvoicesOutstanding: '0.00',
        unallocatedCreditNoteExcess: '0.00',
        advancesAllocatedToInvoices: '0.00',
        invoicesCount: 0,
        creditNotesCount: 0,
        postedBillsOutstanding: '0.00',
        unallocatedDisbursements: '0.00',
        unallocatedDebitNoteExcess: '0.00',
        billsCount: 0,
        paymentsCount: 0,
        debitNotesCount: 0,
        unallocatedReceiptAdvances: '0.00',
        allocatedAdvances: '0.00',
        receiptsCount: 0,
        valuationItemsCount: 0,
      } as any,
      diagnostics: ['No source transactions or journals found for this business entity.'],
    });

    return {
      legalEntityId: legalEntityId.toHexString(),
      currency: 'INR',
      mode,
      asOfDate,
      generatedAt: (this.deps.now ? this.deps.now() : new Date()).toISOString(),
      reconciliationVersion: '1.0',
      status: 'INCOMPLETE',
      summary: {
        totalSections: 6,
        matchedSections: 0,
        mismatchedSections: 0,
        incompleteSections: 6,
        unsupportedSections: 0,
        emptyDataset: true,
      },
      unsupportedConditions: [
        'EMPTY_DATASET: No posted financial transactions or journals recorded for this business entity. Empty dataset cannot be certified as matched.',
      ],
      sections: {
        journalIntegrity: {
          name: 'Journal Balancing & Posting Integrity',
          status: 'INCOMPLETE',
          journalsChecked: 0,
          balancedJournals: 0,
          unbalancedJournals: 0,
          missingPostings: 0,
          duplicatePostings: 0,
          orphanedJournals: 0,
          issues: [],
        },
        tradeReceivables: emptySection('Trade Receivables (AR Control vs Subledger)', '1200') as any,
        tradePayables: emptySection('Trade Payables (AP Control vs Subledger)', '2100') as any,
        customerAdvances: emptySection('Customer Advances (Control vs Subledger)', '2300') as any,
        inventoryValuation: emptySection('Inventory Asset vs Stock Valuation', '1300') as any,
        taxAccounts: {
          name: 'GST Input & Output Tax Control Accounts',
          status: 'INCOMPLETE',
          glBalance: '0.00',
          subledgerBalance: '0.00',
          difference: '0.00',
          subAccounts: [],
          diagnostics: ['No source transactions or journals found for this business entity.'],
        },
      },
    };
  }
}
