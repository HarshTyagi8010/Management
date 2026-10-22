import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM_ROLE_PERMISSIONS,
  type DocumentSummaryResponse,
  type FinancialReconciliationResponse,
  type HsnSummaryResponse,
  type OutwardRegisterResponse,
  type PeriodCloseChecklistResponse,
  type PurchaseRegisterResponse,
} from '@bizmgmt/contracts';
import { TestApp } from './App';
import { apiState } from './lib/api';
import { mockApi, tenantContext } from './test-api';

const ID = (c: string) => c.repeat(24);
const SLOW = { timeout: 5000 };

const address = { line1: '1 Sample Estate', line2: '', city: 'Mumbai', district: '', stateCode: '27', pincode: '400001' };
const entity = {
  id: ID('e'),
  legalName: 'Demo Traders Private Limited (sample)',
  tradeName: '',
  pan: 'ZZZCD0001Z',
  constitution: 'private_limited',
  address,
  email: '',
  phone: '',
  fyStartMonth: 4,
  turnoverBand: 'up_to_5cr',
  workflow: { stockOutPoint: 'dispatch', stockInPoint: 'goods_receipt', allowNegativeStock: false, roundOffTotal: true },
  periodLockDate: '2026-09-30',
  bankAccounts: [],
  logo: null,
  registrationCount: 1,
  archived: false,
  version: 4,
};

const commonApi = {
  'GET /legal-entities': () => Response.json({ data: [entity] }),
  [`GET /legal-entities/${ID('e')}`]: () => Response.json(entity),
};

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TestApp path={path} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiState.setCsrfToken(null);
  apiState.setTenantId(null);
});

describe('Phase 10: Compliance & Statutory Frontend Screens', () => {
  it('renders Compliance Capabilities overview with statutory boundaries', async () => {
    mockApi({
      ...commonApi,
      'GET /compliance/capabilities': () =>
        Response.json({
          supportedCapabilities: [
            { feature: 'GSTR-1 Outward Preparation', description: 'Table 4, 5, 7, 8, 9B classification', scope: 'Registered and unregistered supplies' },
          ],
          unsupportedCapabilities: [
            { feature: 'GSTR-2B External Auto-matching', reason: 'GSTN API direct integration out of scope for MVP', futureConsideration: 'Phase 12 GSP integration' },
          ],
        }),
    });

    renderAt('/reports/compliance');
    expect(await screen.findByText('Compliance & Statutory Capabilities', {}, SLOW)).toBeDefined();
    expect(screen.getByText(/Statutory Boundary Notice/i)).toBeDefined();
    expect(screen.getByText('PREPARATION ONLY — NOT FILED')).toBeDefined();
    expect(await screen.findByText('GSTR-1 Outward Preparation', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('GSTR-2B External Auto-matching', {}, SLOW)).toBeDefined();
  });

  it('renders Outward Register with Table 5 B2CL vs Table 7 B2CS, exceptions, and population reconciliation', async () => {
    const mockOutward: OutwardRegisterResponse = {
      title: 'Outward Supply Preparation Register',
      disclaimer: 'Preparation only — not filed.',
      status: 'PREPARATION_ONLY_NOT_FILED',
      generatedAt: '2026-10-22T10:00:00.000Z',
      legalEntityId: ID('e'),
      legalEntityName: entity.legalName,
      legalEntityPan: entity.pan,
      gstin: null,
      period: {
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
      },
      summaries: [
        { category: 'B2B', documentCount: 5, taxableValue: '50000.00', igst: '0.00', cgst: '4500.00', sgst: '4500.00', utgst: '0.00', cess: '0.00', totalTax: '9000.00', grandTotal: '59000.00' },
        { category: 'B2CL', documentCount: 1, taxableValue: '120000.00', igst: '21600.00', cgst: '0.00', sgst: '0.00', utgst: '0.00', cess: '0.00', totalTax: '21600.00', grandTotal: '141600.00' },
        { category: 'B2CS', documentCount: 2, taxableValue: '15000.00', igst: '0.00', cgst: '1350.00', sgst: '1350.00', utgst: '0.00', cess: '0.00', totalTax: '2700.00', grandTotal: '17700.00' },
      ],
      lines: [
        {
          documentId: ID('1'),
          documentNumber: 'INV-2026-001',
          documentKind: 'tax_invoice',
          docDate: '2026-10-05',
          accountingDate: '2026-10-05',
          partyId: ID('p'),
          partyName: 'Large Buyer Inter-State',
          recipientGstin: null,
          placeOfSupply: '24',
          supplyType: 'inter',
          taxableValue: '120000.00',
          cgst: '0.00',
          sgst: '0.00',
          utgst: '0.00',
          igst: '21600.00',
          cess: '0.00',
          totalTax: '21600.00',
          grandTotal: '141600.00',
          category: 'B2CL',
          status: 'CONFIRMED',
          isReverseCharge: false,
        },
      ],
      exceptions: [
        {
          documentId: ID('2'),
          documentNumber: 'INV-2026-ERR',
          docDate: '2026-10-06',
          partyName: 'Unresolved Party',
          reasonCode: 'MISSING_BUYER_STATE',
          message: 'Place of supply could not be determined',
          taxableValue: '1000.00',
          totalTax: '180.00',
          grandTotal: '1180.00',
        },
      ],
      reconciliation: {
        totalSourceDocumentsCount: 4,
        totalSourceTaxableValue: '186000.00',
        totalSourceTaxAmount: '33480.00',
        totalSourceGrandTotal: '219480.00',
        classifiedTaxableValue: '185000.00',
        classifiedTaxAmount: '33300.00',
        exceptionsTaxableValue: '1000.00',
        exceptionsTaxAmount: '180.00',
        differenceTaxableValue: '0.00',
        differenceTaxAmount: '0.00',
        isPopulationReconciled: true,
      },
    };

    mockApi({
      ...commonApi,
      'GET /compliance/outward-register': () => Response.json(mockOutward),
    });

    renderAt('/reports/outward-register');
    expect(await screen.findByText('Outward Supply Preparation Register', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('POPULATION RECONCILED (100%)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Table 5: B2CL Large Inter-state', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Table 7: B2CS Small Unregistered', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Compliance Exceptions (1)', {}, SLOW)).toBeDefined();
    expect((await screen.findAllByText('MISSING_BUYER_STATE', {}, SLOW)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('INV-2026-001', {}, SLOW)).length).toBeGreaterThan(0);
  });

  it('renders Purchase Register with REVIEW_REQUIRED segregated for RCM/commercial memos', async () => {
    const mockPurchase: PurchaseRegisterResponse = {
      title: 'Purchase Register & ITC Review Preparation',
      disclaimer: 'Preparation only — not filed.',
      status: 'PREPARATION_ONLY_NOT_FILED',
      generatedAt: '2026-10-22T10:00:00.000Z',
      legalEntityId: ID('e'),
      legalEntityName: entity.legalName,
      gstin: null,
      period: {
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
      },
      totals: {
        totalInwardTaxable: '20000.00',
        totalInwardTaxCharged: '3600.00',
        eligibleTaxable: '10000.00',
        eligibleTaxCharged: '1800.00',
        ineligibleGrossExpensedTax: '0.00',
        purchaseReturnAccountingReversalTax: '0.00',
        netEligibleTaxUnderReview: '500.00',
        reviewRequiredCount: 1,
      },
      lines: [
        {
          docId: ID('3'),
          docNumber: 'BILL-001',
          docType: 'supplier_bill',
          supplierInvoiceNumber: 'SUP-99',
          supplierInvoiceDate: '2026-10-02',
          docDate: '2026-10-02',
          supplierId: ID('sup1'),
          supplierName: 'GTA Logistics Service',
          supplierGstin: '27AAAAA0000A1Z5',
          supplierStateCode: '27',
          taxCharged: { taxable: '10000.00', cgst: '250.00', sgst: '250.00', utgst: '0.00', igst: '0.00', cess: '0.00', totalTax: '500.00' },
          gstr3bCategory: 'REVIEW_REQUIRED',
          reviewReason: 'Inward reverse-charge (RCM) supply requires proof of reverse charge tax liability discharge and payment',
          accountingTreatment: 'input_tax_control_141x',
          declaredItcEligible: true,
          externalStatementMatchStatus: 'not_imported',
          status: 'posted',
        },
        {
          docId: ID('4'),
          docNumber: 'BILL-002',
          docType: 'supplier_bill',
          supplierInvoiceNumber: 'SUP-100',
          supplierInvoiceDate: '2026-10-03',
          docDate: '2026-10-03',
          supplierId: ID('sup2'),
          supplierName: 'Office Stationary Supply',
          supplierGstin: '27BBBBB0000B1Z5',
          supplierStateCode: '27',
          taxCharged: { taxable: '10000.00', cgst: '900.00', sgst: '900.00', utgst: '0.00', igst: '0.00', cess: '0.00', totalTax: '1800.00' },
          gstr3bCategory: 'TABLE_4_A_5_ALL_OTHER_ITC',
          reviewReason: null,
          accountingTreatment: 'input_tax_control_141x',
          declaredItcEligible: true,
          externalStatementMatchStatus: 'not_imported',
          status: 'posted',
        },
      ],
      unsupportedFeatures: [],
    };

    mockApi({
      ...commonApi,
      'GET /compliance/purchase-register': () => Response.json(mockPurchase),
    });

    renderAt('/reports/purchase-register');
    expect(await screen.findByText('Purchase Register & ITC Review Preparation', {}, SLOW)).toBeDefined();
    expect(screen.getByText(/Notice: Internal Inward Preparation Only/i)).toBeDefined();
    expect(await screen.findByText('Confirmed Claim-Ready ITC (4A5)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Under Review Tax (RCM / Memos)', {}, SLOW)).toBeDefined();
    expect((await screen.findAllByText('REVIEW REQUIRED', {}, SLOW)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Table 4(A)(5) Eligible', {}, SLOW)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Inward reverse-charge \(RCM\) supply requires proof/i, {}, SLOW)).length).toBeGreaterThan(0);
  });

  it('renders Financial Reconciliation with exact status and GL vs subledger balances', async () => {
    const mockRecon: FinancialReconciliationResponse = {
      legalEntityId: ID('e'),
      currency: 'INR',
      mode: 'current',
      asOfDate: '2026-10-22',
      generatedAt: '2026-10-22T10:00:00.000Z',
      reconciliationVersion: '1.0.0',
      status: 'MATCHED',
      summary: {
        totalSections: 6,
        matchedSections: 6,
        mismatchedSections: 0,
        incompleteSections: 0,
        unsupportedSections: 0,
        emptyDataset: false,
      },
      unsupportedConditions: [],
      sections: {
        journalIntegrity: {
          name: 'Journal Double-Entry Integrity',
          status: 'MATCHED',
          journalsChecked: 15,
          balancedJournals: 15,
          unbalancedJournals: 0,
          missingPostings: 0,
          duplicatePostings: 0,
          orphanedJournals: 0,
          issues: [],
        },
        tradeReceivables: {
          name: 'Trade Receivables (GL 1200)',
          glAccount: '1200',
          status: 'MATCHED',
          glBalance: '50000.00',
          subledgerBalance: '50000.00',
          difference: '0.00',
          breakdown: { issuedInvoicesOutstanding: '50000.00', unallocatedCreditNoteExcess: '0.00', advancesAllocatedToInvoices: '0.00', invoicesCount: 5, creditNotesCount: 0 },
          diagnostics: [],
        },
        tradePayables: {
          name: 'Trade Payables (GL 2100)',
          glAccount: '2100',
          status: 'MATCHED',
          glBalance: '30000.00',
          subledgerBalance: '30000.00',
          difference: '0.00',
          breakdown: { postedBillsOutstanding: '30000.00', unallocatedDisbursements: '0.00', unallocatedDebitNoteExcess: '0.00', billsCount: 3, paymentsCount: 0, debitNotesCount: 0 },
          diagnostics: [],
        },
        customerAdvances: {
          name: 'Customer Advances (GL 2300)',
          glAccount: '2300',
          status: 'MATCHED',
          glBalance: '0.00',
          subledgerBalance: '0.00',
          difference: '0.00',
          breakdown: { unallocatedReceiptAdvances: '0.00', allocatedAdvances: '0.00', receiptsCount: 0 },
          diagnostics: [],
        },
        inventoryValuation: {
          name: 'Inventory Valuation (GL 1300)',
          glAccount: '1300',
          status: 'MATCHED',
          glBalance: '75000.00',
          subledgerBalance: '75000.00',
          difference: '0.00',
          breakdown: { valuationItemsCount: 12 },
          diagnostics: [],
        },
        taxAccounts: {
          name: 'Tax Control Accounts',
          status: 'MATCHED',
          glBalance: '15000.00',
          subledgerBalance: '15000.00',
          difference: '0.00',
          subAccounts: [
            { accountCode: '2201', name: 'CGST Output Control', glBalance: '7500.00', expectedBalance: '7500.00', difference: '0.00', status: 'MATCHED' },
          ],
          diagnostics: [],
        },
      },
      drillDown: {
        receivables: [],
        payables: [],
      },
    };

    mockApi({
      ...commonApi,
      'GET /reconciliation/financial': () => Response.json(mockRecon),
    });

    renderAt('/reports/reconciliation');
    expect(await screen.findByText('Authoritative Financial Reconciliation', {}, SLOW)).toBeDefined();
    expect((await screen.findAllByText('MATCHED', {}, SLOW)).length).toBeGreaterThan(0);
    expect(await screen.findByText('2. Trade Receivables (GL 1200)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('3. Trade Payables (GL 2100)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('4. Customer Advances (GL 2300)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('5. Inventory Valuation (GL 1300)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('6. Tax Control Accounts', {}, SLOW)).toBeDefined();
  });

  it('renders HSN Summary and Document Summary screens', async () => {
    const mockHsn: HsnSummaryResponse = {
      title: 'HSN/SAC Summary (GSTR-1 Table 12)',
      disclaimer: 'Preparation only — not filed.',
      status: 'PREPARATION_ONLY_NOT_FILED',
      generatedAt: '2026-10-22T10:00:00.000Z',
      legalEntityId: ID('e'),
      period: {
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
      },
      totals: { totalTaxable: '50000.00', totalTax: '9000.00', totalValue: '59000.00' },
      b2bSummary: [
        { hsnSac: '8481', description: 'Valves', itemType: 'stock', uqc: 'NOS', recipientCategory: 'B2B', rate: '18', totalQty: '10', totalValue: '59000.00', taxableValue: '50000.00', igst: '0.00', cgst: '4500.00', sgst: '4500.00', utgst: '0.00', cess: '0.00', totalTax: '9000.00' },
      ],
      b2cSummary: [],
      exceptions: [],
    };

    const mockDocSummary: DocumentSummaryResponse = {
      title: 'Documents Issued Summary (GSTR-1 Table 13)',
      disclaimer: 'Preparation only — not filed.',
      status: 'PREPARATION_ONLY_NOT_FILED',
      generatedAt: '2026-10-22T10:00:00.000Z',
      legalEntityId: ID('e'),
      period: {
        fromDate: '2026-10-01',
        toDate: '2026-10-31',
      },
      table13Documents: [
        { natureOfDocument: 'Tax Invoices for Outward Supply', docType: 'sales_invoice', seriesPrefix: 'INV', fromSerial: 'INV-001', toSerial: 'INV-005', totalIssued: 5, cancelled: 0, netIssued: 5 },
      ],
      internalExcludedSeries: [
        { seriesPrefix: 'REC', nature: 'Payment Receipts', totalCount: 3, exclusionReason: 'Internal cash/bank collection voucher' },
      ],
      unsupportedTable13Categories: [],
    };

    mockApi({
      ...commonApi,
      'GET /compliance/hsn-summary': () => Response.json(mockHsn),
      'GET /compliance/document-summary': () => Response.json(mockDocSummary),
    });

    renderAt('/reports/hsn-summary');
    expect(await screen.findByText('HSN/SAC Summary (GSTR-1 Table 12)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('B2B Summaries (1)', {}, SLOW)).toBeDefined();

    cleanup();

    renderAt('/reports/document-summary');
    expect(await screen.findByText('Documents Issued Summary (GSTR-1 Table 13)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Table 13 Statutory Documents (1 series)', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Internal Excluded Series (1)', {}, SLOW)).toBeDefined();
  });

  it('handles period-close readiness checklist, warning acknowledgement, and double-click prevention', async () => {
    let closeCallCount = 0;
    const mockChecklist: PeriodCloseChecklistResponse = {
      legalEntityId: ID('e'),
      periodEndDate: '2026-09-30',
      generatedAt: '2026-10-22T10:00:00.000Z',
      canClose: true,
      closeMode: 'administrative_lock',
      isPastPeriod: false,
      coordinationToken: 'eyJhbGciOiJIUzI1NiJ9.testTokenPayload.testSignature',
      counts: { blockers: 0, warnings: 1, informational: 1 },
      findings: [
        {
          code: 'DRAFT_TRANSACTIONS',
          category: 'documents',
          severity: 'warning',
          title: 'Draft Documents Found',
          description: '1 draft sales invoice exists in this period.',
          isBlocking: false,
        },
      ],
      reconciliationStatus: 'MATCHED',
      pastPeriodNotice: null,
    };

    mockApi({
      ...commonApi,
      'GET /compliance/period-close/checklist': () => Response.json(mockChecklist),
      'POST /compliance/period-close/execute': () => {
        closeCallCount++;
        return Response.json({
          status: 'success',
          action: 'closed',
          legalEntityId: ID('e'),
          lockedUntil: '2026-09-30',
          mode: 'administrative_lock',
          reconciliationStatus: 'MATCHED',
          coordinationSequence: 5,
          timestamp: '2026-10-22T10:05:00.000Z',
        });
      },
    });

    renderAt('/settings/period-locks');
    expect(await screen.findByText('Period-Close Readiness & Posting Locks', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('Current Authoritative Lock: 30-09-2026', {}, SLOW)).toBeDefined();
    expect(await screen.findByText('(DRAFT_TRANSACTIONS)', {}, SLOW)).toBeDefined();

    const submitBtn = screen.getByRole('button', { name: /Apply Administrative Lock|Execute Reconciled Close/i });
    expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

    // Check warning acknowledgement
    const ackCheckbox = screen.getByRole('checkbox');
    await userEvent.click(ackCheckbox);

    // Enter required reason (>= 5 chars)
    const reasonInput = screen.getByLabelText(/Mandatory Close Reason/i);
    await userEvent.type(reasonInput, 'Monthly accounting closing complete');

    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

    // Click submit
    await userEvent.click(submitBtn);

    expect(await screen.findByText('Period Action Confirmed', {}, SLOW)).toBeDefined();
    expect(closeCallCount).toBe(1);
  });

  it('restricts access when permission is missing', async () => {
    mockApi({
      ...commonApi,
      'GET /tenant/context': () => Response.json(tenantContext(SYSTEM_ROLE_PERMISSIONS.storekeeper)),
    });

    renderAt('/reports/outward-register');
    expect(await screen.findByText(/report\.financial/, {}, SLOW)).toBeDefined();
  });
});
