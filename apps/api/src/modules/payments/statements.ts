import { Types, trusted } from 'mongoose';
import type {
  PartyStatementQuery,
  PartyStatementResponse,
} from '@bizmgmt/contracts';
import {
  calculateCustomerStatement,
  calculateSupplierStatement,
  dec,
  money,
  type StatementRawEntry,
} from '@bizmgmt/domain';
import { fromDecimal } from '../../platform/values.js';
import { canInEntity, type TenantContext } from '../tenancy/tenancy.js';
import { forbidden, notFound, type PaymentServices } from './core.js';

export class StatementService {
  constructor(private readonly deps: PaymentServices) {}

  private get models() {
    return this.deps.models;
  }

  async getPartyStatement(ctx: TenantContext, query: PartyStatementQuery): Promise<PartyStatementResponse> {
    if (!ctx.permissions.has('report.financial') && !canInEntity(ctx, 'report.financial', query.legalEntityId)) {
      throw forbidden();
    }

    const entity = await this.models.LegalEntity.findOne({ tenantId: ctx.tenantId, _id: query.legalEntityId }).lean();
    if (!entity) throw notFound('Legal entity');

    const party = await this.models.Party.findOne({ tenantId: ctx.tenantId, _id: query.partyId }).lean();
    if (!party) throw notFound('Party');

    const entityId = new Types.ObjectId(query.legalEntityId);
    const partyId = new Types.ObjectId(query.partyId);

    if (party.isCustomer) {
      // 1. Prior transactions for opening balance
      const priorInvoices = await this.models.SalesInvoice.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $lt: query.from }) },
        { totals: 1 },
      ).lean();

      const priorCreditNotes = await this.models.CreditNote.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $lt: query.from }) },
        { amounts: 1 },
      ).lean();

      const priorReceipts = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'incoming',
          recordKind: trusted({ $ne: 'credit_note_excess' }),
          status: trusted({ $in: ['posted', 'reversed'] }),
          docDate: trusted({ $lt: query.from }),
        },
        { amount: 1, status: 1, reversedAt: 1 },
      ).lean();

      const priorRefunds = await this.models.Refund.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'posted', refundDate: trusted({ $lt: query.from }) },
        { amount: 1 },
      ).lean();

      let openBal = dec('0');
      for (const inv of priorInvoices) openBal = openBal.plus(dec(fromDecimal(inv.totals?.grand) ?? '0'));
      for (const cn of priorCreditNotes) openBal = openBal.minus(dec(fromDecimal(cn.amounts?.grand) ?? '0'));
      for (const rec of priorReceipts) {
        if (rec.status === 'posted') {
          openBal = openBal.minus(dec(fromDecimal(rec.amount) ?? '0'));
        } else if (rec.status === 'reversed') {
          const revDate = rec.reversedAt ? rec.reversedAt.toISOString().slice(0, 10) : null;
          // If reversed on or after query.from, it was still active as of query.from
          if (!revDate || revDate >= query.from) {
            openBal = openBal.minus(dec(fromDecimal(rec.amount) ?? '0'));
          }
        }
      }
      for (const ref of priorRefunds) openBal = openBal.plus(dec(fromDecimal(ref.amount) ?? '0'));

      // 2. In-period transactions
      const periodInvoices = await this.models.SalesInvoice.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $gte: query.from, $lte: query.to }) },
        { number: 1, docDate: 1, totals: 1 },
      ).lean();

      const periodCreditNotes = await this.models.CreditNote.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $gte: query.from, $lte: query.to }) },
        { number: 1, docDate: 1, amounts: 1, reason: 1 },
      ).lean();

      const periodReceipts = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'incoming',
          recordKind: trusted({ $ne: 'credit_note_excess' }),
          docDate: trusted({ $gte: query.from, $lte: query.to }),
        },
        { number: 1, docDate: 1, amount: 1, paymentMethod: 1, reference: 1 },
      ).lean();

      const periodRefunds = await this.models.Refund.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'posted', refundDate: trusted({ $gte: query.from, $lte: query.to }) },
        { number: 1, refundDate: 1, amount: 1, reason: 1 },
      ).lean();

      const rawEntries: StatementRawEntry[] = [];
      for (const inv of periodInvoices) {
        rawEntries.push({
          date: inv.docDate,
          docType: 'sales_invoice',
          docNumber: inv.number ?? '',
          description: `Sales Invoice ${inv.number}`,
          debit: fromDecimal(inv.totals?.grand) ?? '0.00',
          credit: '0.00',
        });
      }
      for (const cn of periodCreditNotes) {
        rawEntries.push({
          date: cn.docDate,
          docType: 'credit_note',
          docNumber: cn.number ?? '',
          description: `Credit Note ${cn.number} (${cn.reason})`,
          debit: '0.00',
          credit: fromDecimal(cn.amounts?.grand) ?? '0.00',
        });
      }
      for (const rec of periodReceipts) {
        rawEntries.push({
          date: rec.docDate,
          docType: 'payment_receipt',
          docNumber: rec.number ?? '',
          description: `Receipt ${rec.number} (${rec.paymentMethod.toUpperCase()}${rec.reference ? ` / ${rec.reference}` : ''})`,
          debit: '0.00',
          credit: fromDecimal(rec.amount) ?? '0.00',
        });
      }
      for (const ref of periodRefunds) {
        rawEntries.push({
          date: ref.refundDate,
          docType: 'refund',
          docNumber: ref.number ?? '',
          description: `Refund ${ref.number} (${ref.reason})`,
          debit: fromDecimal(ref.amount) ?? '0.00',
          credit: '0.00',
        });
      }

      // In-period receipt reversals
      const reversedReceipts = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'incoming',
          recordKind: trusted({ $ne: 'credit_note_excess' }),
          status: 'reversed',
        },
        { number: 1, amount: 1, reversedAt: 1, reversedReason: 1 },
      ).lean();

      for (const rev of reversedReceipts) {
        const revDate = rev.reversedAt ? rev.reversedAt.toISOString().slice(0, 10) : null;
        if (revDate && revDate >= query.from && revDate <= query.to) {
          rawEntries.push({
            date: revDate,
            docType: 'payment_reversal',
            docNumber: rev.number ?? '',
            description: `Payment Reversal ${rev.number} (${rev.reversedReason ?? 'Reversal'})`,
            debit: fromDecimal(rev.amount) ?? '0.00',
            credit: '0.00',
          });
        }
      }

      rawEntries.sort((a, b) => a.date.localeCompare(b.date) || a.docNumber.localeCompare(b.docNumber));
      const statement = calculateCustomerStatement(money(openBal), rawEntries);

      return {
        legalEntityId: entity._id.toHexString(),
        partyId: party._id.toHexString(),
        partyName: party.name,
        from: query.from,
        to: query.to,
        openingBalance: statement.openingBalance,
        closingBalance: statement.closingBalance,
        totalDebit: statement.totalDebit,
        totalCredit: statement.totalCredit,
        entries: statement.entries,
      };
    } else {
      // Supplier Statement
      const priorBills = await this.models.SupplierBill.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, supplierId: partyId, status: 'posted', docDate: trusted({ $lt: query.from }) },
        { totals: 1 },
      ).lean();

      const priorDebitNotes = await this.models.DebitNote.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $lt: query.from }) },
        { amounts: 1 },
      ).lean();

      const priorDisbursements = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'outgoing',
          recordKind: trusted({ $ne: 'debit_note_excess' }),
          status: trusted({ $in: ['posted', 'reversed'] }),
          docDate: trusted({ $lt: query.from }),
        },
        { amount: 1, status: 1, reversedAt: 1 },
      ).lean();

      let openBal = dec('0');
      for (const bill of priorBills) openBal = openBal.plus(dec(fromDecimal(bill.totals.grand) ?? '0'));
      for (const dn of priorDebitNotes) openBal = openBal.minus(dec(fromDecimal(dn.amounts.grand) ?? '0'));
      for (const pmt of priorDisbursements) {
        if (pmt.status === 'posted') {
          openBal = openBal.minus(dec(fromDecimal(pmt.amount) ?? '0'));
        } else if (pmt.status === 'reversed') {
          const revDate = pmt.reversedAt ? pmt.reversedAt.toISOString().slice(0, 10) : null;
          if (!revDate || revDate >= query.from) {
            openBal = openBal.minus(dec(fromDecimal(pmt.amount) ?? '0'));
          }
        }
      }

      const periodBills = await this.models.SupplierBill.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, supplierId: partyId, status: 'posted', docDate: trusted({ $gte: query.from, $lte: query.to }) },
        { number: 1, docDate: 1, totals: 1, supplierInvoiceNumber: 1 },
      ).lean();

      const periodDebitNotes = await this.models.DebitNote.find(
        { tenantId: ctx.tenantId, legalEntityId: entityId, partyId, status: 'issued', docDate: trusted({ $gte: query.from, $lte: query.to }) },
        { number: 1, docDate: 1, amounts: 1, reason: 1 },
      ).lean();

      const periodDisbursements = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'outgoing',
          recordKind: trusted({ $ne: 'debit_note_excess' }),
          docDate: trusted({ $gte: query.from, $lte: query.to }),
        },
        { number: 1, docDate: 1, amount: 1, paymentMethod: 1, reference: 1 },
      ).lean();

      const rawEntries: StatementRawEntry[] = [];
      for (const bill of periodBills) {
        rawEntries.push({
          date: bill.docDate,
          docType: 'supplier_bill',
          docNumber: bill.number ?? bill.supplierInvoiceNumber,
          description: `Supplier Bill ${bill.number} (Inv #${bill.supplierInvoiceNumber})`,
          debit: '0.00',
          credit: fromDecimal(bill.totals.grand) ?? '0.00',
        });
      }
      for (const dn of periodDebitNotes) {
        rawEntries.push({
          date: dn.docDate,
          docType: 'debit_note',
          docNumber: dn.number ?? '',
          description: `Debit Note ${dn.number} (${dn.reason})`,
          debit: fromDecimal(dn.amounts.grand) ?? '0.00',
          credit: '0.00',
        });
      }
      for (const pmt of periodDisbursements) {
        rawEntries.push({
          date: pmt.docDate,
          docType: 'supplier_payment',
          docNumber: pmt.number ?? '',
          description: `Payment ${pmt.number} (${pmt.paymentMethod.toUpperCase()}${pmt.reference ? ` / ${pmt.reference}` : ''})`,
          debit: fromDecimal(pmt.amount) ?? '0.00',
          credit: '0.00',
        });
      }

      // In-period disbursement reversals
      const reversedDisbursements = await this.models.Payment.find(
        {
          tenantId: ctx.tenantId,
          legalEntityId: entityId,
          partyId,
          direction: 'outgoing',
          recordKind: trusted({ $ne: 'debit_note_excess' }),
          status: 'reversed',
        },
        { number: 1, amount: 1, reversedAt: 1, reversedReason: 1 },
      ).lean();

      for (const rev of reversedDisbursements) {
        const revDate = rev.reversedAt ? rev.reversedAt.toISOString().slice(0, 10) : null;
        if (revDate && revDate >= query.from && revDate <= query.to) {
          rawEntries.push({
            date: revDate,
            docType: 'payment_reversal',
            docNumber: rev.number ?? '',
            description: `Payment Reversal ${rev.number} (${rev.reversedReason ?? 'Reversal'})`,
            debit: '0.00',
            credit: fromDecimal(rev.amount) ?? '0.00',
          });
        }
      }

      rawEntries.sort((a, b) => a.date.localeCompare(b.date) || a.docNumber.localeCompare(b.docNumber));
      const statement = calculateSupplierStatement(money(openBal), rawEntries);

      return {
        legalEntityId: entity._id.toHexString(),
        partyId: party._id.toHexString(),
        partyName: party.name,
        from: query.from,
        to: query.to,
        openingBalance: statement.openingBalance,
        closingBalance: statement.closingBalance,
        totalDebit: statement.totalDebit,
        totalCredit: statement.totalCredit,
        entries: statement.entries,
      };
    }
  }
}
