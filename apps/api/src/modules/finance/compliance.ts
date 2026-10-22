import { createHash } from 'node:crypto';
import { trusted, Types } from 'mongoose';
import {
  COMPLIANCE_STATUS,
  type ComplianceCapabilitiesResponse,
  type DocumentSummaryResponse,
  type HsnSummaryItem,
  type HsnSummaryResponse,
  type OutwardExceptionItem,
  type OutwardRegisterResponse,
  type OutwardSupplyCategory,
  type OutwardSupplyLine,
  type OutwardSupplySummary,
  type PeriodCloseChecklistResponse,
  type PeriodCloseExecuteRequest,
  type PeriodCloseExecuteResponse,
  type PurchaseRegisterLine,
  type PurchaseRegisterResponse,
} from '@bizmgmt/contracts';
import { serializeToCsv, type CsvColumnDef } from '@bizmgmt/domain';
import { AppError } from '../../errors.js';
import type { Models } from '../../models.js';
import type { CreditNoteDoc, DebitNoteDoc, ExpenseDoc } from '../../models-payments.js';
import type { SupplierBillDoc } from '../../models-purchases.js';
import type { SalesDocDoc } from '../../models-sales.js';
import { hmac, safeEqual, type Keyring } from '../../platform/crypto.js';
import { todayIST } from '../../platform/values.js';
import type { AuditLog } from '../audit/audit.js';
import type { RequestMeta } from '../identity/identity.js';
import type { TenantContext } from '../tenancy/tenancy.js';
import type { ReconciliationService } from './reconciliation.js';

interface Deps {
  models: Models;
  reconciliation: ReconciliationService;
  keys?: Keyring | undefined;
  now?: (() => Date) | undefined;
  audit?: AuditLog | undefined;
}

export class ComplianceService {
  constructor(private readonly deps: Deps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private signCoordinationPayload(payloadB64: string): string {
    const key = this.deps.keys?.data || Buffer.from('bizmgmt-period-close-coordination-secret-2026-fallback', 'utf8');
    return hmac(key, payloadB64);
  }

  private verifyCoordinationToken(payloadB64: string, signature: string): boolean {
    const expected = this.signCoordinationPayload(payloadB64);
    return safeEqual(expected, signature);
  }

  // ------------------------------------------------------------ Capabilities
  getCapabilities(): ComplianceCapabilitiesResponse {
    return {
      disclaimer: 'Statutory preparation only — not filed. No direct GSTN portal filing or simulated upload.',
      status: COMPLIANCE_STATUS,
      supportedCapabilities: [
        {
          feature: 'Outward Supply Preparation Register',
          description: 'Classifies outward supplies into B2B (Table 4A), B2CL (Table 5: large inter-state unregistered supplies > ₹1L on or after 2024-08-01 per Notif 12/2024-CT; > ₹2.5L before), B2CS (Table 7: all intra-state and small inter-state unregistered supplies), Nil/Exempt/Non-GST (Table 8), and CDNR/CDNUR (Table 9B).',
          scope: 'Regular and Composition registered legal entities, domestic supplies within India.',
        },
        {
          feature: 'Purchase Register / ITC Review Preparation',
          description: 'Classifies inward bills, expenses, and marks purchase return commercial memos and inward reverse charge (RCM) supplies lacking tax payment/discharge proof as REVIEW_REQUIRED (preventing premature statutory claim).',
          scope: 'Supplier bills, direct expenses, and purchase return debit notes.',
        },
        {
          feature: 'HSN/SAC Summaries',
          description: 'Groups line items by HSN/SAC with B2B vs B2C separation, turnover-mandated digit validation, and service UQC formatting.',
          scope: 'All issued sales invoices in the reporting period.',
        },
        {
          feature: 'Document Issued Summaries (Table 13)',
          description: 'Counts issued and cancelled documents by series for statutory documents while explicitly excluding internal documents and buyer purchase return memos.',
          scope: 'Tax invoices, bills of supply, credit notes.',
        },
        {
          feature: 'Period-Close Readiness Checklist',
          description: 'Evaluates period close readiness with informational, warning, and blocker findings, cryptographic HMAC token binding, live coordination sequence freshness, and past-period administrative lock.',
          scope: 'Legal entity period locking and close authorization.',
        },
        {
          feature: 'Typed Spreadsheet-Safe CSV Exports',
          description: 'Exports preparation registers to RFC 4180 CSV with formula-injection neutralization and preserved numeric types.',
          scope: 'All compliance preparation reports.',
        },
      ],
      unsupportedCapabilities: [
        {
          feature: 'Direct GSTN Portal Live Filing',
          reason: 'No external GSTN API or live credentials provided in scope.',
          futureConsideration: 'Requires authorized GSP/ASP integration.',
        },
        {
          feature: 'Live GSTR-2B Statement Auto-Matching',
          reason: 'External GSTR-2B statement import is not yet connected.',
          futureConsideration: 'Requires JSON/Excel portal statement ingestion pipeline.',
        },
        {
          feature: 'Direct Statutory Table 4(A)(3) Inward RCM Claim',
          reason: 'Inward reverse charge liability discharge and tax payment evidence is unsupported without GSTN cash ledger / payment challan verification.',
          futureConsideration: 'Tag inward RCM bills for manual review; keep outside confirmed claim-ready totals.',
        },
        {
          feature: 'Multi-Currency & Overseas Exports',
          reason: 'Current statutory models enforce domestic INR transactions.',
          futureConsideration: 'Foreign currency and shipping bill tracking.',
        },
      ],
    };
  }

  // ------------------------------------------------------------ Outward Supply Register
  async getOutwardRegister(
    ctx: TenantContext,
    params: { legalEntityId: string; fromDate: string; toDate: string; gstRegistrationId?: string | undefined },
  ): Promise<OutwardRegisterResponse> {

    const legalEntityId = new Types.ObjectId(params.legalEntityId);
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: legalEntityId }).lean();
    if (!entity) throw new AppError('NOT_FOUND', 'Business entity not found');

    const filter: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: trusted({ $in: ['issued', 'paid', 'partially_paid', 'unpaid'] }),
    };
    if (params.gstRegistrationId) {
      filter.gstRegistrationId = new Types.ObjectId(params.gstRegistrationId);
    }

    const invoices = (await this.deps.models.SalesInvoice.find(filter).lean()) as unknown as SalesDocDoc[];

    // Fetch credit notes issued in the same period
    const creditNotes = (await this.deps.models.CreditNote.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: 'issued',
    }).lean()) as unknown as CreditNoteDoc[];

    const lines: OutwardSupplyLine[] = [];
    const exceptions: OutwardExceptionItem[] = [];

    // Helper decimal parse
    const dec = (v: unknown): number => (v ? parseFloat(String(v)) : 0);

    for (const inv of invoices) {
      const taxable = dec(inv.totals?.taxable);
      const cgst = dec(inv.totals?.cgst);
      const sgst = dec(inv.totals?.sgst);
      const utgst = dec(inv.totals?.utgst);
      const igst = dec(inv.totals?.igst);
      const cess = dec(inv.totals?.cess);
      const totalTax = cgst + sgst + utgst + igst + cess;
      const grandTotal = dec(inv.totals?.grand);

      const recipientGstin = inv.buyer?.gstin?.trim() || null;
      const hasGstin = Boolean(recipientGstin && recipientGstin.length === 15);
      const isInterState = inv.supply === 'inter';
      const docDate = inv.docDate;

      // Threshold for B2CL:
      // Notification 12/2024-CT (10-07-2024), clauses 11(ii) and 28: effective 1 August 2024
      const b2clThreshold = docDate >= '2024-08-01' ? 100000 : 250000;

      // Check exceptions first
      let isException = false;
      let exceptionReason: OutwardExceptionItem['reasonCode'] | null = null;
      let exceptionMessage = '';

      if (!inv.placeOfSupply) {
        isException = true;
        exceptionReason = 'MISSING_BUYER_STATE';
        exceptionMessage = 'Place of supply is missing on invoice.';
      } else if (inv.documentKind === 'tax_invoice' && totalTax === 0 && taxable > 0) {
        // Zero tax on a tax invoice without explicit exemption
        isException = true;
        exceptionReason = 'AMBIGUOUS_ZERO_RATE';
        exceptionMessage = 'Tax rate is zero on a tax invoice without verified exemption classification.';
      }

      if (isException && exceptionReason) {
        exceptions.push({
          documentId: inv._id.toHexString(),
          documentNumber: inv.number || 'DRAFT',
          docDate: inv.docDate,
          partyName: inv.partyName,
          reasonCode: exceptionReason,
          message: exceptionMessage,
          taxableValue: taxable.toFixed(2),
          totalTax: totalTax.toFixed(2),
          grandTotal: grandTotal.toFixed(2),
        });
        continue;
      }

      // Categorize
      let category: OutwardSupplyCategory = 'B2CS';

      if (inv.documentKind === 'bill_of_supply') {
        category = 'EXEMPTED';
      } else if (hasGstin) {
        category = 'B2B';
      } else if (isInterState && grandTotal > b2clThreshold) {
        category = 'B2CL';
      } else {
        category = 'B2CS';
      }

      lines.push({
        documentId: inv._id.toHexString(),
        documentNumber: inv.number || '',
        documentKind: inv.documentKind,
        docDate: inv.docDate,
        accountingDate: inv.docDate,
        partyId: inv.partyId ? inv.partyId.toHexString() : null,
        partyName: inv.partyName,
        recipientGstin,
        placeOfSupply: inv.placeOfSupply,
        supplyType: inv.supply,
        category,
        taxableValue: taxable.toFixed(2),
        cgst: cgst.toFixed(2),
        sgst: sgst.toFixed(2),
        utgst: utgst.toFixed(2),
        igst: igst.toFixed(2),
        cess: cess.toFixed(2),
        totalTax: totalTax.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
        status: inv.status,
        isReverseCharge: Boolean(inv.totals?.reverseChargeTax && dec(inv.totals.reverseChargeTax) > 0),
      });
    }

    // Process Credit Notes
    for (const cn of creditNotes) {
      const taxable = dec(cn.amounts?.taxable);
      const cgst = dec(cn.amounts?.cgst);
      const sgst = dec(cn.amounts?.sgst);
      const utgst = dec(cn.amounts?.utgst);
      const igst = dec(cn.amounts?.igst);
      const cess = dec(cn.amounts?.cess);
      const totalTax = cgst + sgst + utgst + igst + cess;
      const grandTotal = dec(cn.amounts?.grand);

      // Check linked invoice to determine recipient registration and original supply category
      let linkedInv = invoices.find((i) => i._id.equals(cn.salesInvoiceId));
      if (!linkedInv && cn.salesInvoiceId) {
        linkedInv = (await this.deps.models.SalesInvoice.findOne({
          tenantId: ctx.tenantId,
          _id: cn.salesInvoiceId,
        }).lean()) as unknown as SalesDocDoc;
      }

      const hasGstin = Boolean(linkedInv?.buyer?.gstin && linkedInv.buyer.gstin.trim().length === 15);
      const invDocDate = linkedInv?.docDate || cn.docDate;
      const invThreshold = invDocDate >= '2024-08-01' ? 100000 : 250000;
      const isLinkedB2CL = Boolean(
        linkedInv &&
        !hasGstin &&
        linkedInv.supply === 'inter' &&
        dec(linkedInv.totals?.grand) > invThreshold,
      );

      // Official GST rule: CDNUR (Table 9B) is strictly for B2CL supplies.
      // Unregistered notes against B2CS are netted in Table 7 (B2CS), retained in line drill-down.
      let category: OutwardSupplyCategory;
      if (hasGstin) {
        category = 'CDNR';
      } else if (isLinkedB2CL) {
        category = 'CDNUR';
      } else {
        category = 'B2CS';
      }

      lines.push({
        documentId: cn._id.toHexString(),
        documentNumber: cn.number || '',
        documentKind: 'credit_note',
        docDate: cn.docDate,
        accountingDate: cn.docDate,
        partyId: cn.partyId ? cn.partyId.toHexString() : null,
        partyName: cn.partyName,
        recipientGstin: linkedInv?.buyer?.gstin || null,
        placeOfSupply: linkedInv?.placeOfSupply || entity.address.stateCode,
        supplyType: linkedInv?.supply || 'intra',
        category,
        taxableValue: (-taxable).toFixed(2),
        cgst: (-cgst).toFixed(2),
        sgst: (-sgst).toFixed(2),
        utgst: (-utgst).toFixed(2),
        igst: (-igst).toFixed(2),
        cess: (-cess).toFixed(2),
        totalTax: (-totalTax).toFixed(2),
        grandTotal: (-grandTotal).toFixed(2),
        status: cn.status,
        isReverseCharge: false,
      });
    }

    // Summaries by category
    const categories: OutwardSupplyCategory[] = ['B2B', 'B2CL', 'B2CS', 'NIL_RATED', 'EXEMPTED', 'NON_GST', 'CDNR', 'CDNUR'];
    const summaries: OutwardSupplySummary[] = categories.map((cat) => {
      const catLines = lines.filter((l) => l.category === cat);
      let sTaxable = 0;
      let sCgst = 0;
      let sSgst = 0;
      let sUtgst = 0;
      let sIgst = 0;
      let sCess = 0;
      let sGrand = 0;

      for (const cl of catLines) {
        sTaxable += parseFloat(cl.taxableValue);
        sCgst += parseFloat(cl.cgst);
        sSgst += parseFloat(cl.sgst);
        sUtgst += parseFloat(cl.utgst);
        sIgst += parseFloat(cl.igst);
        sCess += parseFloat(cl.cess);
        sGrand += parseFloat(cl.grandTotal);
      }

      const sTotalTax = sCgst + sSgst + sUtgst + sIgst + sCess;

      return {
        category: cat,
        documentCount: catLines.length,
        taxableValue: sTaxable.toFixed(2),
        cgst: sCgst.toFixed(2),
        sgst: sSgst.toFixed(2),
        utgst: sUtgst.toFixed(2),
        igst: sIgst.toFixed(2),
        cess: sCess.toFixed(2),
        totalTax: sTotalTax.toFixed(2),
        grandTotal: sGrand.toFixed(2),
      };
    });

    // Reconcile total population
    const totalSourceDocs = invoices.length + creditNotes.length;
    let totalSourceTaxable = 0;
    let totalSourceTax = 0;
    let totalSourceGrand = 0;

    for (const inv of invoices) {
      totalSourceTaxable += dec(inv.totals?.taxable);
      const tax = dec(inv.totals?.cgst) + dec(inv.totals?.sgst) + dec(inv.totals?.utgst) + dec(inv.totals?.igst) + dec(inv.totals?.cess);
      totalSourceTax += tax;
      totalSourceGrand += dec(inv.totals?.grand);
    }
    for (const cn of creditNotes) {
      totalSourceTaxable -= dec(cn.amounts?.taxable);
      const tax = dec(cn.amounts?.cgst) + dec(cn.amounts?.sgst) + dec(cn.amounts?.utgst) + dec(cn.amounts?.igst) + dec(cn.amounts?.cess);
      totalSourceTax -= tax;
      totalSourceGrand -= dec(cn.amounts?.grand);
    }

    const classifiedTaxable = summaries.reduce((acc, s) => acc + parseFloat(s.taxableValue), 0);
    const classifiedTax = summaries.reduce((acc, s) => acc + parseFloat(s.totalTax), 0);
    const exceptionsTaxable = exceptions.reduce((acc, e) => acc + parseFloat(e.taxableValue), 0);
    const exceptionsTax = exceptions.reduce((acc, e) => acc + parseFloat(e.totalTax), 0);

    const diffTaxable = Math.abs(totalSourceTaxable - (classifiedTaxable + exceptionsTaxable));
    const diffTax = Math.abs(totalSourceTax - (classifiedTax + exceptionsTax));
    const isReconciled = diffTaxable < 0.01 && diffTax < 0.01;

    return {
      title: 'Outward Supply Preparation Register',
      disclaimer: 'Preparation only — not filed.',
      status: COMPLIANCE_STATUS,
      generatedAt: this.now().toISOString(),
      legalEntityId: entity._id.toHexString(),
      legalEntityName: entity.legalName,
      legalEntityPan: entity.pan,
      gstin: params.gstRegistrationId || null,
      period: {
        fromDate: params.fromDate,
        toDate: params.toDate,
      },
      summaries,
      lines,
      exceptions,
      reconciliation: {
        totalSourceDocumentsCount: totalSourceDocs,
        totalSourceTaxableValue: totalSourceTaxable.toFixed(2),
        totalSourceTaxAmount: totalSourceTax.toFixed(2),
        totalSourceGrandTotal: totalSourceGrand.toFixed(2),
        classifiedTaxableValue: classifiedTaxable.toFixed(2),
        classifiedTaxAmount: classifiedTax.toFixed(2),
        exceptionsTaxableValue: exceptionsTaxable.toFixed(2),
        exceptionsTaxAmount: exceptionsTax.toFixed(2),
        differenceTaxableValue: diffTaxable.toFixed(2),
        differenceTaxAmount: diffTax.toFixed(2),
        isPopulationReconciled: isReconciled,
      },
    };
  }

  // ------------------------------------------------------------ Purchase Register / ITC Review
  async getPurchaseRegister(
    ctx: TenantContext,
    params: { legalEntityId: string; fromDate: string; toDate: string },
  ): Promise<PurchaseRegisterResponse> {
    const legalEntityId = new Types.ObjectId(params.legalEntityId);
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: legalEntityId }).lean();
    if (!entity) throw new AppError('NOT_FOUND', 'Business entity not found');

    const bills = (await this.deps.models.SupplierBill.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: 'posted',
    }).lean()) as unknown as SupplierBillDoc[];

    const expenses = (await this.deps.models.Expense.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: 'posted',
    }).lean()) as unknown as ExpenseDoc[];

    const debitNotes = (await this.deps.models.DebitNote.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: 'issued',
    }).lean()) as unknown as DebitNoteDoc[];

    const dec = (v: unknown): number => (v ? parseFloat(String(v)) : 0);
    const lines: PurchaseRegisterLine[] = [];

    let totalInwardTaxable = 0;
    let totalInwardTaxCharged = 0;
    let eligibleTaxable = 0;
    let eligibleItcAvailable = 0;
    let ineligibleGrossExpensedTax = 0;
    let purchaseReturnReversalsTax = 0;

    for (const b of bills) {
      const taxable = dec(b.totals?.taxable);
      let cgst = dec(b.totals?.cgst);
      let sgst = dec(b.totals?.sgst);
      let utgst = dec(b.totals?.utgst);
      let igst = dec(b.totals?.igst);
      let cess = dec(b.totals?.cess);
      let totalTax = cgst + sgst + utgst + igst + cess;

      const isEligible = Boolean(b.itcEligible);
      const isRcm = Boolean(
        (b.totals?.reverseChargeTax && dec(b.totals.reverseChargeTax) > 0) ||
        b.lines?.some((l) => Boolean(l.reverseCharge))
      );

      const rcmTax = dec(b.totals?.reverseChargeTax);
      if (isRcm && totalTax === 0 && rcmTax > 0) {
        totalTax = rcmTax;
        const isInter = Boolean(
          b.supplier?.stateCode && entity.address?.stateCode && b.supplier.stateCode !== entity.address.stateCode,
        );
        if (isInter) {
          igst = rcmTax;
        } else {
          cgst = rcmTax / 2;
          sgst = rcmTax / 2;
        }
      }

      totalInwardTaxable += taxable;
      totalInwardTaxCharged += totalTax;

      let gstr3bCategory: PurchaseRegisterLine['gstr3bCategory'] = isEligible
        ? 'TABLE_4_A_5_ALL_OTHER_ITC'
        : 'INELIGIBLE_GROSS_EXPENSED';
      let reviewReason: string | null = null;

      if (isRcm) {
        gstr3bCategory = 'REVIEW_REQUIRED';
        reviewReason = 'Inward reverse-charge (RCM) supply requires proof of reverse charge tax liability discharge and payment before statutory Table 4(A)(3) ITC claim';
      }

      if (gstr3bCategory === 'TABLE_4_A_5_ALL_OTHER_ITC') {
        eligibleTaxable += taxable;
        eligibleItcAvailable += totalTax;
      } else if (gstr3bCategory === 'INELIGIBLE_GROSS_EXPENSED') {
        ineligibleGrossExpensedTax += totalTax;
      }

      lines.push({
        docId: b._id.toHexString(),
        docNumber: b.number || 'BILL',
        docType: 'supplier_bill',
        supplierInvoiceNumber: b.supplierInvoiceNumber || null,
        supplierInvoiceDate: b.supplierInvoiceDate || null,
        docDate: b.docDate,
        supplierId: b.supplierId ? b.supplierId.toHexString() : null,
        supplierName: b.supplierName,
        supplierGstin: b.supplier?.gstin || null,
        supplierStateCode: b.supplier?.stateCode || null,
        taxCharged: {
          taxable: taxable.toFixed(2),
          cgst: cgst.toFixed(2),
          sgst: sgst.toFixed(2),
          utgst: utgst.toFixed(2),
          igst: igst.toFixed(2),
          cess: cess.toFixed(2),
          totalTax: totalTax.toFixed(2),
        },
        accountingTreatment: isEligible ? 'input_tax_control_141x' : 'gross_cost_5100_1300',
        declaredItcEligible: isEligible,
        gstr3bCategory,
        reviewReason,
        externalStatementMatchStatus: 'not_imported',
        status: b.status,
      });
    }

    for (const exp of expenses) {
      const taxable = dec(exp.taxableAmount);
      const totalTax = dec(exp.taxAmount);
      const isEligible = Boolean(exp.itcEligible);

      totalInwardTaxable += taxable;
      totalInwardTaxCharged += totalTax;

      if (isEligible) {
        eligibleTaxable += taxable;
        eligibleItcAvailable += totalTax;
      } else {
        ineligibleGrossExpensedTax += totalTax;
      }

      lines.push({
        docId: exp._id.toHexString(),
        docNumber: exp.number || 'EXP',
        docType: 'direct_expense',
        supplierInvoiceNumber: exp.reference || null,
        supplierInvoiceDate: exp.docDate,
        docDate: exp.docDate,
        supplierId: null,
        supplierName: exp.payeeName || exp.category,
        supplierGstin: null,
        supplierStateCode: null,
        taxCharged: {
          taxable: taxable.toFixed(2),
          cgst: '0.00',
          sgst: '0.00',
          utgst: '0.00',
          igst: totalTax.toFixed(2),
          cess: '0.00',
          totalTax: totalTax.toFixed(2),
        },
        accountingTreatment: isEligible ? 'input_tax_control_141x' : 'gross_cost_5100_1300',
        declaredItcEligible: isEligible,
        gstr3bCategory: isEligible ? 'TABLE_4_A_5_ALL_OTHER_ITC' : 'INELIGIBLE_GROSS_EXPENSED',
        reviewReason: null,
        externalStatementMatchStatus: 'not_imported',
        status: exp.status,
      });
    }

    // Debit notes (Purchase returns / Commercial buyer debit memos)
    for (const dn of debitNotes) {
      const taxable = dec(dn.amounts?.taxable);
      const cgst = dec(dn.amounts?.cgst);
      const sgst = dec(dn.amounts?.sgst);
      const utgst = dec(dn.amounts?.utgst);
      const igst = dec(dn.amounts?.igst);
      const cess = dec(dn.amounts?.cess);
      const totalTax = cgst + sgst + utgst + igst + cess;

      // Look up linked supplier bill to check ITC eligibility
      const linkedBill = await this.deps.models.SupplierBill.findOne({
        tenantId: ctx.tenantId,
        _id: dn.supplierBillId,
      }).lean();

      const wasBillEligible = Boolean(linkedBill?.itcEligible);

      if (wasBillEligible) {
        purchaseReturnReversalsTax += totalTax;
      }

      lines.push({
        docId: dn._id.toHexString(),
        docNumber: dn.number || 'DN',
        docType: 'purchase_return_debit_note',
        supplierInvoiceNumber: dn.supplierBillNumber || null,
        supplierInvoiceDate: null,
        docDate: dn.docDate,
        supplierId: dn.partyId ? dn.partyId.toHexString() : null,
        supplierName: dn.partyName,
        supplierGstin: null,
        supplierStateCode: null,
        taxCharged: {
          taxable: (-taxable).toFixed(2),
          cgst: (-cgst).toFixed(2),
          sgst: (-sgst).toFixed(2),
          utgst: (-utgst).toFixed(2),
          igst: (-igst).toFixed(2),
          cess: (-cess).toFixed(2),
          totalTax: (-totalTax).toFixed(2),
        },
        accountingTreatment: wasBillEligible ? 'input_tax_control_141x' : 'gross_cost_5100_1300',
        declaredItcEligible: wasBillEligible,
        gstr3bCategory: 'REVIEW_REQUIRED',
        reviewReason: 'Commercial purchase return memo requires supplier GST credit note confirmation or GSTR-2B match to determine Table 4(B)(2) reversal vs net Table 4(A)(5) reduction',
        externalStatementMatchStatus: 'not_imported',
        status: dn.status,
      });
    }

    const netItcUnderReview = eligibleItcAvailable - purchaseReturnReversalsTax;
    const reviewRequiredCount = lines.filter((l) => l.gstr3bCategory === 'REVIEW_REQUIRED').length;

    return {
      title: 'Purchase Register / ITC Review Preparation — not filed.',
      disclaimer: 'Preparation only — not filed. Not a GSTR-2B external statement reconciliation.',
      status: COMPLIANCE_STATUS,
      generatedAt: this.now().toISOString(),
      legalEntityId: entity._id.toHexString(),
      legalEntityName: entity.legalName,
      gstin: null,
      period: {
        fromDate: params.fromDate,
        toDate: params.toDate,
      },
      lines,
      totals: {
        totalInwardTaxable: totalInwardTaxable.toFixed(2),
        totalInwardTaxCharged: totalInwardTaxCharged.toFixed(2),
        eligibleTaxable: eligibleTaxable.toFixed(2),
        eligibleTaxCharged: eligibleItcAvailable.toFixed(2),
        ineligibleGrossExpensedTax: ineligibleGrossExpensedTax.toFixed(2),
        purchaseReturnAccountingReversalTax: purchaseReturnReversalsTax.toFixed(2),
        netEligibleTaxUnderReview: netItcUnderReview.toFixed(2),
        reviewRequiredCount,
      },
      unsupportedFeatures: [
        'Automated Inward Reverse Charge (RCM)',
        'Input Service Distributor (ISD) credits',
        'Import Bill of Entry automated matching',
        'Direct portal GSTR-2B API matching',
      ],
    };
  }

  // ------------------------------------------------------------ HSN / SAC Summary
  async getHsnSummary(
    ctx: TenantContext,
    params: { legalEntityId: string; fromDate: string; toDate: string },
  ): Promise<HsnSummaryResponse> {
    const legalEntityId = new Types.ObjectId(params.legalEntityId);
    const invoices = (await this.deps.models.SalesInvoice.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
      status: trusted({ $in: ['issued', 'paid', 'partially_paid', 'unpaid'] }),
    }).lean()) as unknown as SalesDocDoc[];

    const b2bMap = new Map<string, HsnSummaryItem>();
    const b2cMap = new Map<string, HsnSummaryItem>();
    const exceptions: Array<{ documentNumber: string; lineId: string; itemName: string; reason: string }> = [];

    const dec = (v: unknown): number => (v ? parseFloat(String(v)) : 0);

    for (const inv of invoices) {
      const isB2B = Boolean(inv.buyer?.gstin && inv.buyer.gstin.trim().length === 15);
      const targetMap = isB2B ? b2bMap : b2cMap;
      const recipientCategory = isB2B ? 'B2B' : 'B2C';

      for (const line of inv.lines || []) {
        const hsn = line.item?.hsnSac?.trim();
        if (!hsn) {
          exceptions.push({
            documentNumber: inv.number || 'INV',
            lineId: line.lineId,
            itemName: line.item?.name || 'Unknown Item',
            reason: 'MISSING_HSN_SAC_CODE',
          });
          continue;
        }

        const isService = line.item?.type === 'service';
        const uqc = isService ? 'NA' : line.item?.uqc || 'OTH';
        const qty = isService ? 0 : dec(line.qty);
        const rate = line.taxRate ? line.taxRate.toString() : '0';
        const key = `${hsn}_${rate}_${uqc}`;

        const taxable = dec(line.amounts?.taxable);
        const cgst = dec(line.amounts?.cgst);
        const sgst = dec(line.amounts?.sgst);
        const utgst = dec(line.amounts?.utgst);
        const igst = dec(line.amounts?.igst);
        const cess = dec(line.amounts?.cess);
        const total = dec(line.amounts?.total);
        const totalTax = cgst + sgst + utgst + igst + cess;

        let existing = targetMap.get(key);
        if (!existing) {
          existing = {
            hsnSac: hsn,
            description: line.item?.name || '',
            itemType: line.item?.type || 'stock',
            uqc,
            recipientCategory,
            rate,
            totalQty: isService ? null : '0',
            totalValue: '0.00',
            taxableValue: '0.00',
            cgst: '0.00',
            sgst: '0.00',
            utgst: '0.00',
            igst: '0.00',
            cess: '0.00',
            totalTax: '0.00',
          };
          targetMap.set(key, existing);
        }

        const curQty = existing.totalQty ? parseFloat(existing.totalQty) : 0;
        existing.totalQty = isService ? null : (curQty + qty).toFixed(2);
        existing.totalValue = (parseFloat(existing.totalValue) + total).toFixed(2);
        existing.taxableValue = (parseFloat(existing.taxableValue) + taxable).toFixed(2);
        existing.cgst = (parseFloat(existing.cgst) + cgst).toFixed(2);
        existing.sgst = (parseFloat(existing.sgst) + sgst).toFixed(2);
        existing.utgst = (parseFloat(existing.utgst) + utgst).toFixed(2);
        existing.igst = (parseFloat(existing.igst) + igst).toFixed(2);
        existing.cess = (parseFloat(existing.cess) + cess).toFixed(2);
        existing.totalTax = (parseFloat(existing.totalTax) + totalTax).toFixed(2);
      }
    }

    const b2bSummary = Array.from(b2bMap.values()).sort((a, b) => a.hsnSac.localeCompare(b.hsnSac));
    const b2cSummary = Array.from(b2cMap.values()).sort((a, b) => a.hsnSac.localeCompare(b.hsnSac));

    let grandTaxable = 0;
    let grandTax = 0;
    let grandValue = 0;

    for (const item of [...b2bSummary, ...b2cSummary]) {
      grandTaxable += parseFloat(item.taxableValue);
      grandTax += parseFloat(item.totalTax);
      grandValue += parseFloat(item.totalValue);
    }

    return {
      title: 'HSN / SAC Summary (GSTR-1 Table 12 Preparation)',
      disclaimer: 'Preparation only — not filed.',
      status: COMPLIANCE_STATUS,
      generatedAt: this.now().toISOString(),
      legalEntityId: legalEntityId.toHexString(),
      period: {
        fromDate: params.fromDate,
        toDate: params.toDate,
      },
      b2bSummary,
      b2cSummary,
      exceptions,
      totals: {
        totalTaxable: grandTaxable.toFixed(2),
        totalTax: grandTax.toFixed(2),
        totalValue: grandValue.toFixed(2),
      },
    };
  }

  // ------------------------------------------------------------ Document Issued Summary (Table 13)
  async getDocumentSummary(
    ctx: TenantContext,
    params: { legalEntityId: string; fromDate: string; toDate: string },
  ): Promise<DocumentSummaryResponse> {
    const legalEntityId = new Types.ObjectId(params.legalEntityId);

    // Statutory documents: Tax Invoices, Bills of Supply, Credit Notes, Debit Notes
    const invoices = await this.deps.models.SalesInvoice.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
    }).lean();

    const creditNotes = await this.deps.models.CreditNote.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
    }).lean();

    const debitNotes = await this.deps.models.DebitNote.find({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
    }).lean();

    // Group invoices by series or kind
    const table13Documents = [];

    // Tax invoices
    const taxInvs = invoices.filter((i) => i.documentKind === 'tax_invoice');
    if (taxInvs.length > 0) {
      const numbers = taxInvs.map((i) => i.number || '').filter(Boolean).sort();
      const cancelled = taxInvs.filter((i) => i.status === 'cancelled').length;
      table13Documents.push({
        natureOfDocument: 'Invoices for outward supply',
        docType: 'tax_invoice',
        seriesPrefix: numbers[0]?.split('/')[0] || 'INV',
        fromSerial: numbers[0] || 'N/A',
        toSerial: numbers[numbers.length - 1] || 'N/A',
        totalIssued: taxInvs.length,
        cancelled,
        netIssued: taxInvs.length - cancelled,
      });
    }

    // Bills of supply
    const billsOfSupply = invoices.filter((i) => i.documentKind === 'bill_of_supply');
    if (billsOfSupply.length > 0) {
      const numbers = billsOfSupply.map((i) => i.number || '').filter(Boolean).sort();
      const cancelled = billsOfSupply.filter((i) => i.status === 'cancelled').length;
      table13Documents.push({
        natureOfDocument: 'Bills of supply',
        docType: 'bill_of_supply',
        seriesPrefix: numbers[0]?.split('/')[0] || 'BOS',
        fromSerial: numbers[0] || 'N/A',
        toSerial: numbers[numbers.length - 1] || 'N/A',
        totalIssued: billsOfSupply.length,
        cancelled,
        netIssued: billsOfSupply.length - cancelled,
      });
    }

    // Credit notes
    if (creditNotes.length > 0) {
      const numbers = creditNotes.map((cn) => cn.number || '').filter(Boolean).sort();
      const cancelled = creditNotes.filter((cn) => cn.status === 'cancelled').length;
      table13Documents.push({
        natureOfDocument: 'Credit notes',
        docType: 'credit_note',
        seriesPrefix: numbers[0]?.split('/')[0] || 'CN',
        fromSerial: numbers[0] || 'N/A',
        toSerial: numbers[numbers.length - 1] || 'N/A',
        totalIssued: creditNotes.length,
        cancelled,
        netIssued: creditNotes.length - cancelled,
      });
    }

    // Note: GSTR-1 Table 13 Entry 4 tracks outward statutory debit notes issued under Section 34.
    // Buyer purchase-return debit notes (DebitNote model) are inward commercial memos and must NOT be reported in Table 13.

    // Internal excluded series count
    const billsCount = await this.deps.models.SupplierBill.countDocuments({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
    });
    const paymentsCount = await this.deps.models.Payment.countDocuments({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gte: params.fromDate, $lte: params.toDate }),
    });

    const internalExcludedSeries = [
      {
        seriesPrefix: 'DN',
        nature: 'Buyer Purchase Return Debit Memos',
        exclusionReason: 'Inward commercial debit memos issued to suppliers are not outward statutory debit notes under GSTR-1 Table 13.',
        totalCount: debitNotes.length,
      },
      {
        seriesPrefix: 'BILL',
        nature: 'Supplier Bills',
        exclusionReason: 'Inward commercial bills are not outward supply documents under Table 13.',
        totalCount: billsCount,
      },
      {
        seriesPrefix: 'PAY',
        nature: 'Cash / Bank Payments and Receipts',
        exclusionReason: 'Financial vouchers are internal accounting records, excluded from Table 13.',
        totalCount: paymentsCount,
      },
    ];

    const unsupportedTable13Categories = [
      'Table 13 Entry 4: Outward statutory debit notes (Section 34 upward outward revisions)',
      'Table 13 Entry 5: Revised invoices',
      'Table 13 Entry 6: Delivery challans for job work',
      'Table 13 Entry 7: Delivery challans for supply on approval',
      'Table 13 Entry 8: Delivery challans in case of liquid gas',
      'Table 13 Entry 9: Delivery challans in cases other than by way of supply',
      'Table 13 Entry 10: Receipt vouchers',
      'Table 13 Entry 11: Payment vouchers',
      'Table 13 Entry 12: Refund vouchers',
    ];

    return {
      title: 'Documents Issued Summary (GSTR-1 Table 13 Preparation)',
      disclaimer: 'Preparation only — not filed. Limited summary disclosing supported and unsupported categories.',
      status: COMPLIANCE_STATUS,
      generatedAt: this.now().toISOString(),
      legalEntityId: legalEntityId.toHexString(),
      period: {
        fromDate: params.fromDate,
        toDate: params.toDate,
      },
      table13Documents,
      internalExcludedSeries,
      unsupportedTable13Categories,
    };
  }

  // ------------------------------------------------------------ Period-Close Readiness Checklist
  async getPeriodCloseChecklist(
    ctx: TenantContext,
    params: {
      legalEntityId: string;
      periodEndDate: string;
      mode?: 'reconciled_close' | 'administrative_lock' | undefined;
    },
  ): Promise<PeriodCloseChecklistResponse> {
    const legalEntityId = new Types.ObjectId(params.legalEntityId);
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: legalEntityId }).lean();
    if (!entity) throw new AppError('NOT_FOUND', 'Business entity not found');

    const findings = [];
    let blockers = 0;
    let warnings = 0;
    let informational = 0;

    // Detect if closing a past period (subsequent transactions exist after periodEndDate)
    const hasSubsequentJournals = await this.deps.models.Journal.exists({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gt: params.periodEndDate }),
    });
    const hasSubsequentInvoices = await this.deps.models.SalesInvoice.exists({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gt: params.periodEndDate }),
    });
    const hasSubsequentBills = await this.deps.models.SupplierBill.exists({
      tenantId: ctx.tenantId,
      legalEntityId,
      docDate: trusted({ $gt: params.periodEndDate }),
    });
    const isPastPeriod = Boolean(hasSubsequentJournals || hasSubsequentInvoices || hasSubsequentBills);

    const closeMode: 'reconciled_close' | 'administrative_lock' =
      params.mode || (isPastPeriod ? 'administrative_lock' : 'reconciled_close');

    // 1. Authoritative Financial Reconciliation Check
    let reconStatus = 'UNKNOWN';

    if (closeMode === 'administrative_lock') {
      reconStatus = 'NOT_APPLICABLE_ADMIN_LOCK';
      findings.push({
        code: 'ADMINISTRATIVE_LOCK_MODE',
        category: 'reconciliation' as const,
        severity: 'warning' as const,
        title: 'Administrative Posting Lock Mode (Non-Reconciled)',
        description: 'Administrative posting lock selected. Subsequent ledger transactions exist. Historical financial balances are not verified or reconciled by this action.',
        isBlocking: false,
      });
      warnings++;
    } else if (isPastPeriod && closeMode === 'reconciled_close') {
      reconStatus = 'UNSUPPORTED_HISTORICAL';
      findings.push({
        code: 'HISTORICAL_RECONCILIATION_UNSUPPORTED',
        category: 'reconciliation' as const,
        severity: 'blocker' as const,
        title: 'Historical Reconciled Close Unsupported',
        description: 'Subsequent ledger transactions exist after requested period end date. Current-state reconciliation cannot establish past closing balances. Reconciled close is blocked for historical periods.',
        isBlocking: true,
      });
      blockers++;
    } else {
      try {
        const recon = await this.deps.reconciliation.reconcileFinancial(ctx.tenantId, {
          legalEntityId: params.legalEntityId,
          mode: 'current',
          drillDown: false,
        });
        reconStatus = recon.status;

        if (recon.status === 'MATCHED') {
          findings.push({
            code: 'RECON_MATCHED',
            category: 'reconciliation' as const,
            severity: 'informational' as const,
            title: 'Financial Control Accounts Reconciled',
            description: 'All 6 financial control sections (AR, AP, Advances, Inventory, Taxes, Journals) match subledgers.',
            isBlocking: false,
          });
          informational++;
        } else if (recon.status === 'INCOMPLETE') {
          findings.push({
            code: 'RECON_INCOMPLETE',
            category: 'reconciliation' as const,
            severity: 'warning' as const,
            title: 'Financial Reconciliation Incomplete (No Activity / Empty Ledger)',
            description: 'No transactions found in control accounts. Acknowledge if closing an initial or idle period.',
            isBlocking: false,
          });
          warnings++;
        } else {
          findings.push({
            code: 'RECON_DISCREPANCY',
            category: 'reconciliation' as const,
            severity: 'blocker' as const,
            title: 'Financial Control Account Discrepancy Detected',
            description: 'Subledger and General Ledger balances do not match. Discrepancies must be resolved before closing.',
            isBlocking: true,
            details: { status: recon.status },
          });
          blockers++;
        }
      } catch (err: any) {
        findings.push({
          code: 'RECON_FAILED',
          category: 'reconciliation' as const,
          severity: 'blocker' as const,
          title: 'Reconciliation Execution Failed or Timed Out',
          description: err.message || 'Execution error during reconciliation.',
          isBlocking: true,
        });
        blockers++;
      }
    }

    // 2. Journal Balancing Check (Direct Database Inspection)
    const unbalancedJournals = await this.deps.models.Journal.aggregate([
      { $match: { tenantId: ctx.tenantId, legalEntityId } },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$_id',
          sourceNumber: { $first: '$sourceNumber' },
          totalDebit: { $sum: { $toDouble: '$lines.debit' } },
          totalCredit: { $sum: { $toDouble: '$lines.credit' } },
        },
      },
      {
        $project: {
          sourceNumber: 1,
          diff: { $abs: { $subtract: ['$totalDebit', '$totalCredit'] } },
        },
      },
      { $match: { diff: { $gt: 0.001 } } },
    ]);

    if (unbalancedJournals.length > 0) {
      findings.push({
        code: 'UNBALANCED_JOURNAL_BLOCKER',
        category: 'journal_integrity' as const,
        severity: 'blocker' as const,
        title: 'Unbalanced Journals Exist in Ledger',
        description: `Found ${unbalancedJournals.length} journals where total debits do not equal total credits.`,
        isBlocking: true,
        details: { count: unbalancedJournals.length },
      });
      blockers++;
    } else {
      findings.push({
        code: 'JOURNALS_BALANCED',
        category: 'journal_integrity' as const,
        severity: 'informational' as const,
        title: 'All General Ledger Journals are Strictly Balanced',
        description: 'Debits equal credits across all journal entries.',
        isBlocking: false,
      });
      informational++;
    }

    // 3. Document Integrity Checks: Draft documents dated on or before period end
    const draftInvoicesCount = await this.deps.models.SalesInvoice.countDocuments({
      tenantId: ctx.tenantId,
      legalEntityId,
      status: 'draft',
      docDate: trusted({ $lte: params.periodEndDate }),
    });
    const draftBillsCount = await this.deps.models.SupplierBill.countDocuments({
      tenantId: ctx.tenantId,
      legalEntityId,
      status: 'draft',
      docDate: trusted({ $lte: params.periodEndDate }),
    });

    if (draftInvoicesCount > 0 || draftBillsCount > 0) {
      findings.push({
        code: 'DRAFT_DOCUMENTS_PENDING',
        category: 'documents' as const,
        severity: 'warning' as const,
        title: 'Draft Documents Exist in Period',
        description: `Found ${draftInvoicesCount} draft invoice(s) and ${draftBillsCount} draft bill(s). User acknowledgement required.`,
        isBlocking: false,
        details: { draftInvoicesCount, draftBillsCount },
      });
      warnings++;
    }

    // 4. Past period retrospective closing policy
    let pastPeriodNotice: string | null = null;
    const currentLock = entity.periodLockDate;
    if (currentLock && params.periodEndDate <= currentLock) {
      findings.push({
        code: 'PERIOD_ALREADY_LOCKED',
        category: 'reconciliation' as const,
        severity: 'blocker' as const,
        title: 'Period is Already Locked',
        description: `The period up to ${currentLock} is already locked. Moving the lock backward requires period.unlock.`,
        isBlocking: true,
      });
      blockers++;
    } else if (isPastPeriod) {
      pastPeriodNotice = closeMode === 'administrative_lock'
        ? 'Administrative posting lock only: historical financial balances are not verified or reconciled by this action.'
        : 'Subsequent ledger transactions exist. Historical reconciled closing is blocked.';
    } else {
      pastPeriodNotice = 'Closing is evaluated against current immutable ledger evidence.';
    }

    const canClose = blockers === 0;

    // Cryptographic and state freshness binding
    const warningsList = findings
      .filter((f) => f.severity === 'warning')
      .map((f) => `${f.code}:${f.title}`)
      .sort()
      .join('|');
    const warningsHash = createHash('sha256').update(warningsList).digest('hex').slice(0, 16);

    const tokenPayload = {
      tenantId: ctx.tenantId.toHexString(),
      legalEntityId: entity._id.toHexString(),
      periodEndDate: params.periodEndDate,
      closeMode,
      coordinationSeq: entity.periodLockCoordination || 0,
      warningsHash,
      warningsCount: warnings,
      blockersCount: blockers,
      generatedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + 30 * 60 * 1000).toISOString(),
    };
    const payloadB64 = Buffer.from(JSON.stringify(tokenPayload)).toString('base64url');
    const signature = this.signCoordinationPayload(payloadB64);
    const coordinationToken = `${payloadB64}.${signature}`;

    return {
      legalEntityId: entity._id.toHexString(),
      periodEndDate: params.periodEndDate,
      generatedAt: this.now().toISOString(),
      canClose,
      closeMode,
      isPastPeriod,
      coordinationToken,
      counts: {
        blockers,
        warnings,
        informational,
      },
      findings,
      reconciliationStatus: reconStatus,
      pastPeriodNotice,
    };
  }

  // ------------------------------------------------------------ Race-Safe Period Close Execution
  async executePeriodClose(
    ctx: TenantContext,
    input: PeriodCloseExecuteRequest,
    meta?: RequestMeta,
  ): Promise<PeriodCloseExecuteResponse> {
    const legalEntityId = new Types.ObjectId(input.legalEntityId);
    const entity = await this.deps.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: legalEntityId }).lean();
    if (!entity) throw new AppError('NOT_FOUND', 'Business entity not found');

    if (input.periodEndDate >= todayIST(this.now())) {
      throw new AppError('VALIDATION_FAILED', 'Lock a period that has ended: choose a date before today', [
        { path: 'periodEndDate', message: 'Must be before today' },
      ]);
    }

    const requestedMode = input.mode || 'reconciled_close';

    // 1. Decode and validate token structure and cryptographic bindings
    const parts = (input.coordinationToken || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AppError('VALIDATION_FAILED', 'Invalid coordination token format', [
        { path: 'coordinationToken', message: 'Malformed coordination token' },
      ]);
    }
    const payloadB64 = parts[0];
    const signature = parts[1];
    if (!this.verifyCoordinationToken(payloadB64, signature)) {
      throw new AppError('VALIDATION_FAILED', 'Invalid coordination token signature: token was forged or altered', [
        { path: 'coordinationToken', message: 'Coordination token signature verification failed' },
      ]);
    }

    let tokenData: {
      tenantId: string;
      legalEntityId: string;
      periodEndDate: string;
      closeMode: 'reconciled_close' | 'administrative_lock';
      coordinationSeq: number;
      warningsHash: string;
      warningsCount: number;
      blockersCount: number;
      generatedAt: string;
      expiresAt: string;
    };
    try {
      tokenData = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Invalid coordination token format', [
        { path: 'coordinationToken', message: 'Malformed coordination token' },
      ]);
    }

    if (new Date(tokenData.expiresAt).getTime() < this.now().getTime()) {
      throw new AppError('BUSINESS_RULE', 'Period close coordination token has expired. Please refresh the checklist.', [
        { path: 'coordinationToken', message: 'Coordination token expired' },
      ]);
    }

    if (
      tokenData.tenantId !== ctx.tenantId.toHexString() ||
      tokenData.legalEntityId !== input.legalEntityId ||
      tokenData.periodEndDate !== input.periodEndDate
    ) {
      throw new AppError('VALIDATION_FAILED', 'Coordination token does not match entity, tenant, or period', [
        { path: 'coordinationToken', message: 'Token scope mismatch' },
      ]);
    }

    if (tokenData.closeMode !== requestedMode) {
      throw new AppError('VALIDATION_FAILED', `Coordination token was evaluated for ${tokenData.closeMode}, but requested close mode is ${requestedMode}`, [
        { path: 'mode', message: 'Close mode mismatch' },
      ]);
    }

    if (tokenData.blockersCount > 0) {
      throw new AppError('BUSINESS_RULE', 'Cannot execute close using a token that contained active blockers', [
        { path: 'coordinationToken', message: 'Token had active blockers' },
      ]);
    }

    // 2. Check token freshness against entity's live periodLockCoordination
    if ((entity.periodLockCoordination || 0) !== tokenData.coordinationSeq) {
      throw new AppError(
        'BUSINESS_RULE',
        'Period close could not be completed because financial postings or period state changes occurred after the checklist was generated. Please refresh the checklist.',
        [{ path: 'coordinationToken', message: 'Stale coordination token' }],
      );
    }

    // 3. Authoritative real-time re-evaluation of checklist
    const freshChecklist = await this.getPeriodCloseChecklist(ctx, {
      legalEntityId: input.legalEntityId,
      periodEndDate: input.periodEndDate,
      mode: requestedMode,
    });

    if (freshChecklist.counts.blockers > 0) {
      throw new AppError('BUSINESS_RULE', 'Cannot close period with active blockers', [
        { path: 'blockers', message: `${freshChecklist.counts.blockers} blocking issues must be resolved first` },
      ]);
    }

    // Bind warning acknowledgements to the exact evaluated warning set
    const freshWarningFindings = freshChecklist.findings.filter((f) => f.severity === 'warning');
    const freshWarningsList = freshWarningFindings
      .map((f) => `${f.code}:${f.title}`)
      .sort()
      .join('|');
    const freshWarningsHash = createHash('sha256').update(freshWarningsList).digest('hex').slice(0, 16);

    if (tokenData.warningsHash !== freshWarningsHash) {
      throw new AppError(
        'BUSINESS_RULE',
        'Checklist findings or warnings have changed since the checklist was evaluated. Please refresh the checklist to review updated findings.',
        [{ path: 'coordinationToken', message: 'Evaluated warning set has changed' }],
      );
    }

    if (freshChecklist.counts.warnings > 0 && !input.acknowledgeWarnings) {
      throw new AppError('VALIDATION_FAILED', 'Must acknowledge warnings to close period', [
        { path: 'acknowledgeWarnings', message: 'Active warnings require explicit acknowledgement' },
      ]);
    }

    // 4. Atomic lock update reusing existing contention-safe infrastructure
    const updated = await this.deps.models.LegalEntity.findOneAndUpdate(
      {
        tenantId: ctx.tenantId,
        _id: legalEntityId,
        periodLockCoordination: tokenData.coordinationSeq,
      },
      {
        $set: { periodLockDate: input.periodEndDate },
        $inc: { version: 1, periodLockCoordination: 1 },
      },
      { returnDocument: 'after' },
    ).lean();

    if (!updated) {
      throw new AppError(
        'BUSINESS_RULE',
        'Period close could not be completed due to concurrent postings or state changes. Please review the checklist and try again.',
      );
    }

    if (this.deps.audit) {
      await this.deps.audit.record({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        requestId: meta?.requestId ?? 'unknown',
        ipHash: meta?.ipHash ?? 'unknown',
        action: 'period.locked',
        entityType: 'legal_entity',
        entityId: legalEntityId.toHexString(),
        summary: requestedMode === 'administrative_lock'
          ? `Applied administrative posting lock up to ${input.periodEndDate} for "${entity.legalName}"`
          : `Executed reconciled period close up to ${input.periodEndDate} for "${entity.legalName}"`,
        changes: [
          { field: 'periodLockDate', from: entity.periodLockDate, to: input.periodEndDate },
          { field: 'mode', to: requestedMode },
          { field: 'reason', to: input.reason },
        ],
      });
    }

    return {
      success: true,
      periodLockDate: input.periodEndDate,
      closeMode: requestedMode,
      message: requestedMode === 'administrative_lock'
        ? `Successfully applied administrative posting lock up to ${input.periodEndDate} (historical non-reconciled)`
        : `Successfully locked period up to ${input.periodEndDate}`,
      closedAt: this.now().toISOString(),
    };
  }

  // ------------------------------------------------------------ CSV Exports
  exportOutwardRegisterCsv(report: OutwardRegisterResponse): string {
    const columns: CsvColumnDef<OutwardSupplyLine>[] = [
      { id: 'documentNumber', header: 'Document Number', type: 'text' },
      { id: 'docDate', header: 'Document Date', type: 'date' },
      { id: 'partyName', header: 'Party Name', type: 'text' },
      { id: 'recipientGstin', header: 'Recipient GSTIN', type: 'text' },
      { id: 'placeOfSupply', header: 'Place of Supply', type: 'text' },
      { id: 'category', header: 'GSTR Category', type: 'text' },
      { id: 'taxableValue', header: 'Taxable Value', type: 'numeric' },
      { id: 'cgst', header: 'CGST', type: 'numeric' },
      { id: 'sgst', header: 'SGST', type: 'numeric' },
      { id: 'igst', header: 'IGST', type: 'numeric' },
      { id: 'cess', header: 'CESS', type: 'numeric' },
      { id: 'totalTax', header: 'Total Tax', type: 'numeric' },
      { id: 'grandTotal', header: 'Invoice Total', type: 'numeric' },
    ];

    return serializeToCsv(report.lines, columns);
  }

  exportPurchaseRegisterCsv(report: PurchaseRegisterResponse): string {
    const columns: CsvColumnDef<PurchaseRegisterLine>[] = [
      { id: 'docNumber', header: 'Document Number', type: 'text' },
      { id: 'docType', header: 'Document Type', type: 'text' },
      { id: 'docDate', header: 'Accounting Date', type: 'date' },
      { id: 'supplierName', header: 'Supplier Name', type: 'text' },
      { id: 'supplierGstin', header: 'Supplier GSTIN', type: 'text' },
      { id: 'declaredItcEligible', header: 'ITC Eligible', type: 'boolean' },
      { id: 'gstr3bCategory', header: 'GSTR-3B Category', type: 'text' },
      { id: 'reviewReason', header: 'Review Reason', type: 'text' },
      { id: 'taxable', header: 'Taxable Amount', type: 'numeric', accessor: (r) => r.taxCharged.taxable },
      { id: 'cgst', header: 'CGST', type: 'numeric', accessor: (r) => r.taxCharged.cgst },
      { id: 'sgst', header: 'SGST', type: 'numeric', accessor: (r) => r.taxCharged.sgst },
      { id: 'igst', header: 'IGST', type: 'numeric', accessor: (r) => r.taxCharged.igst },
      { id: 'cess', header: 'CESS', type: 'numeric', accessor: (r) => r.taxCharged.cess },
      { id: 'totalTax', header: 'Total Tax', type: 'numeric', accessor: (r) => r.taxCharged.totalTax },
    ];

    return serializeToCsv(report.lines, columns);
  }

  exportHsnSummaryCsv(report: HsnSummaryResponse): string {
    const allItems = [...report.b2bSummary, ...report.b2cSummary];
    const columns: CsvColumnDef<HsnSummaryItem>[] = [
      { id: 'hsnSac', header: 'HSN/SAC', type: 'text' },
      { id: 'description', header: 'Description', type: 'text' },
      { id: 'recipientCategory', header: 'Category (B2B/B2C)', type: 'text' },
      { id: 'uqc', header: 'UQC', type: 'text' },
      { id: 'totalQty', header: 'Quantity', type: 'text' },
      { id: 'rate', header: 'Tax Rate (%)', type: 'text' },
      { id: 'taxableValue', header: 'Taxable Value', type: 'numeric' },
      { id: 'totalTax', header: 'Total Tax', type: 'numeric' },
      { id: 'totalValue', header: 'Total Value', type: 'numeric' },
    ];

    return serializeToCsv(allItems, columns);
  }

  exportDocumentSummaryCsv(report: DocumentSummaryResponse): string {
    const columns: CsvColumnDef<DocumentSummaryResponse['table13Documents'][number]>[] = [
      { id: 'natureOfDocument', header: 'Nature of Document', type: 'text' },
      { id: 'seriesPrefix', header: 'Series Prefix', type: 'text' },
      { id: 'fromSerial', header: 'From Serial No.', type: 'text' },
      { id: 'toSerial', header: 'To Serial No.', type: 'text' },
      { id: 'totalIssued', header: 'Total Issued', type: 'integer' },
      { id: 'cancelled', header: 'Cancelled', type: 'integer' },
      { id: 'netIssued', header: 'Net Issued', type: 'integer' },
    ];

    return serializeToCsv(report.table13Documents, columns);
  }
}
